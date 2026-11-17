// self-compact: lets Claude compact its own session at a checkpoint it picks.
//
// - Registers the tool mcp__self-compact__compact({ carry, then? }). The call only
//   schedules: compaction cannot run under the turn that made the call, so it runs
//   as soon as that turn ends (turn.complete), through $.session.compact where the
//   engine offers it (interactive terminal) and through the built-in /compact
//   command elsewhere (the desktop app, Agent SDK hosts), which run it as a turn.
// - After the compaction the carry note is appended verbatim as a user-role row
//   that opens with the machine's clock, and `then`, if given, is submitted as
//   the next prompt.
// - While a request waits for the turn to end, the session's state file has
//   `pending` set: a Stop hook can read it and stand aside for that stop, so
//   the note is not made stale by work the hook would ask for (README). A Stop
//   hook that blocks anyway (/goal) does not hold the compaction off: the turn
//   is ended at its next model request, and the hook's message is sent on.
// - No classic.* or session.compact hooks: on a machine with managed settings,
//   or a Team or Enterprise plan, cc-plugin-sec-default passes those events on
//   past installed plugins (and tells the session so). What they gave is read
//   from the turn's steps and the transcript instead.
// - A soft mark: after tool calls and user prompts, the real context size of the
//   last call is read from the transcript; past the threshold Claude gets one
//   line, once, then again only every further `step` tokens. It never blocks.
import type { Register } from 'claude-code'
import {
  INPUT_SCHEMA, PLUGIN, TOOL, TOOL_DESCRIPTION, TOOL_FULL,
  applyEnv, carryRow, compactionsInTail, failureRow, isOneShot, lastContextFromTail, lastReportFromTail, markDecision,
  markLine, nextPrompt, readSettings, stopFeedbackFromTail, summariserInstructions,
} from './lib'
import type { Settings } from './lib'

// held: the message of a Stop hook (such as /goal) whose block the plugin lifted so the
// turn could end for the compaction; it is sent on as the next prompt.
type Request = { carry: string; then?: string; requestedAt: number; contextBefore?: number; held?: string }
type Outcome =
  | { ok: true; via: string; tokensBefore?: number; tokensAfter?: number; usage?: unknown }
  | { ok: false; via: string; reason: string }

// One module instance runs per session process; its variables start over on a reload.
const S: {
  settings: Settings
  transcriptPath?: string
  stateDir?: string
  sessionId?: string
  oneShot: boolean
  pending?: Request // asked for, waiting for the turn to end
  running: boolean // from the turn's end to the compaction's outcome
  ended?: { turnId: string; index: number } // the main loop's last step, when it ended the turn (no tool calls)
  cut?: string // the turn this plugin ended so a waiting compaction could run
  nextMarkAt?: number
  lastCompactionAt?: number // when the latest compaction of this session finished, by anyone
} = { settings: readSettings({}), oneShot: false, running: false }

function errText(err: unknown): string {
  return String((err as any)?.message ?? err)
}

async function configDir($: any): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
}

async function tail($: any, path: string, bytes: number): Promise<string | undefined> {
  try {
    const r = await $.process.run(['/usr/bin/tail', '-c', String(bytes), path], { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

async function findTranscript($: any): Promise<string | undefined> {
  if (S.transcriptPath) return S.transcriptPath
  try {
    const id = S.sessionId ?? (S.sessionId = await $.session.id())
    const r = await $.process.run(['/bin/sh', '-c', 'ls -t "$1"/projects/*/"$2".jsonl 2>/dev/null | head -1', 'sh', await configDir($), id])
    const p = r.stdout.trim()
    if (p) S.transcriptPath = p
  } catch {}
  return S.transcriptPath
}

// Real context size of the last main-conversation call: input + cache read + cache write.
async function readContext($: any): Promise<number | undefined> {
  const path = await findTranscript($)
  if (!path) return undefined
  for (const bytes of [262_144, 4_000_000]) {
    const text = await tail($, path, bytes)
    if (text === undefined) return undefined
    const ctx = lastContextFromTail(text)
    if (ctx !== undefined) return ctx
  }
  return undefined
}

// Claude's last report before the compact call, read while the transcript still ends with this turn.
async function readLastReport($: any): Promise<string | undefined> {
  const path = await findTranscript($)
  if (!path) return undefined
  for (const bytes of [1_000_000, 8_000_000]) {
    const text = await tail($, path, bytes)
    if (text === undefined) return undefined
    const report = lastReportFromTail(text)
    if (report !== undefined) return report
  }
  return undefined
}

async function saveState($: any, extra: Record<string, unknown>): Promise<void> {
  if (!S.stateDir || !S.sessionId) return
  const state = { sessionId: S.sessionId, transcriptPath: S.transcriptPath, nextMarkAt: S.nextMarkAt, lastCompactionAt: S.lastCompactionAt, pending: S.pending ?? null, ...extra }
  try {
    await $.fs.write(`${S.stateDir}/sessions/${S.sessionId}.json`, JSON.stringify(state, null, 2) + '\n')
  } catch {}
}

// One line appended with `>>`: several sessions log here, and reading the file
// to write it back whole let two that finished together drop each other's line.
async function appendLog($: any, entry: Record<string, unknown>): Promise<void> {
  if (!S.stateDir) return
  try {
    await $.process.run(
      ['/bin/sh', '-c', 'mkdir -p "$1" && printf \'%s\\n\' "$2" >> "$1/compactions.jsonl"', 'sh', S.stateDir, JSON.stringify(entry)],
      { timeoutMs: 10_000 },
    )
  } catch {}
}

async function maybeMark($: any): Promise<string | undefined> {
  if (!S.settings.enabled || S.pending || S.running) return undefined
  const ctx = await readContext($)
  if (ctx === undefined) return undefined
  const d = markDecision(ctx, S.nextMarkAt, S.settings)
  const changed = d.nextAt !== S.nextMarkAt
  S.nextMarkAt = d.nextAt
  if (changed) await saveState($, {})
  return d.mark ? markLine(ctx) : undefined
}

async function note($: any, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (err) {
    $.ui.log(`${PLUGIN}: could not add a note to the conversation: ${errText(err)}`)
  }
}

async function compactViaCommand($: any, instructions: string, startedAt: number, first: string): Promise<Outcome> {
  try {
    await $.command.run({ command: 'compact', args: instructions })
    // The outcome is read from the transcript: on a machine with managed settings
    // (or a Team or Enterprise plan) the built-in cc-plugin-sec-default passes the
    // session.compact event on past installed plugins, so no hook of ours hears it.
    const path = await findTranscript($)
    const text = path ? await tail($, path, 4_000_000) : undefined
    const done = text ? compactionsInTail(text).filter((c) => c.at >= startedAt).pop() : undefined
    return done
      ? { ok: true, via: '/compact', tokensBefore: done.preTokens, tokensAfter: done.postTokens }
      : { ok: false, via: '/compact', reason: 'the /compact command ran but did not compact the conversation' }
  } catch (err) {
    return { ok: false, via: '/compact', reason: `${errText(err)} (and $.session.compact: ${first})` }
  }
}

// When the session was last compacted before `beforeMs`, by anyone (automatic,
// typed or this plugin): the newer of the state file's time and the transcript's.
async function previousCompactionAt($: any, beforeMs: number): Promise<number | undefined> {
  const path = await findTranscript($)
  const text = path ? await tail($, path, 4_000_000) : undefined
  const seen = text ? compactionsInTail(text).filter((c) => c.at < beforeMs).pop()?.at : undefined
  const known = S.lastCompactionAt !== undefined && S.lastCompactionAt < beforeMs ? S.lastCompactionAt : undefined
  return seen === undefined ? known : known === undefined ? seen : Math.max(seen, known)
}

async function runCompaction($: any, req: Request): Promise<void> {
  const instructions = summariserInstructions()
  const report = await readLastReport($)
  const startedAt = Date.now()
  let outcome: Outcome
  try {
    const c: any = await $.session.compact({ instructions })
    outcome = c?.skip !== undefined
      ? { ok: false, via: 'session.compact', reason: String(c.skip) }
      : { ok: true, via: 'session.compact', tokensBefore: c?.tokensBefore, tokensAfter: c?.tokensAfter, usage: c?.usage }
  } catch (err) {
    // Not offered here (headless hosts: the desktop app, the Agent SDK), or a turn
    // started meanwhile: the built-in /compact command, queued until the session
    // is idle, does the same compaction as a turn of its own.
    outcome = await compactViaCommand($, instructions, startedAt, errText(err))
  }

  if (outcome.ok) {
    S.nextMarkAt = undefined
    const now = Date.now()
    const prev = await previousCompactionAt($, startedAt)
    const sincePrevMs = prev !== undefined && now > prev ? now - prev : undefined
    S.lastCompactionAt = now
    await note($, carryRow(req.carry, req.contextBefore, req.then, { now: new Date(now), sincePrevMs }, report, req.held))
  } else {
    await note($, failureRow(outcome.reason, !!req.then, !!req.held))
  }
  S.running = false
  await saveState($, { last: { ...outcome, requestedAt: req.requestedAt, finishedAt: Date.now() } })
  await appendLog($, {
    at: new Date().toISOString(), sessionId: S.sessionId, transcriptPath: S.transcriptPath, ...outcome,
    contextBefore: req.contextBefore, requestedAt: new Date(req.requestedAt).toISOString(),
    durationMs: Date.now() - startedAt, carryChars: req.carry.length, reportChars: report?.length ?? 0, hasThen: !!req.then, heldStopHook: !!req.held,
  })
  const prompt = nextPrompt(req.then, req.held)
  if (prompt) {
    try {
      await $.prompt.submit({ text: prompt })
    } catch (err) {
      $.ui.log(`${PLUGIN}: could not submit the next prompt: ${errText(err)}`)
    }
  }
}

// A compaction can only run once the turn has ended. A Stop hook that blocks the
// end (such as /goal, which keeps a session working until its condition is met)
// keeps the same turn going, and would hold the compaction off for as long as it
// keeps blocking: hours in a long session. Classic Stop hooks cannot be hooked
// everywhere (cc-plugin-sec-default passes classic events on past installed
// plugins), so this is seen from the turn's steps instead: while a compaction
// waits, a model request that starts after a step that ended the turn means
// something kept the turn going. Then that step is not sent, the turn is ended
// (no interruption marker), the compaction runs, and the Stop hook's message,
// read from the transcript, is sent as the next prompt: the session carries on as
// the hook asked, on a compacted context, and the hook decides again when that
// turn ends. Turns with no compaction waiting are untouched.
async function cutForCompaction($: any, turnId: string): Promise<boolean> {
  const req = S.pending
  if (!req || S.running) return false
  let held: string | undefined
  for (const waitMs of [0, 150, 500]) {
    if (waitMs) await new Promise<void>((resolve) => $.clock.after(waitMs, () => resolve()))
    const path = await findTranscript($)
    const text = path ? await tail($, path, 1_000_000) : undefined
    held = text ? stopFeedbackFromTail(text, req.requestedAt) : undefined
    if (held) break
  }
  req.held = held ?? 'A Stop hook (or something else) kept the turn going after you ended it for the compaction; its message could not be read from the transcript. Carry on with the work in progress.'
  S.cut = turnId
  await saveState($, {})
  try {
    await $.turn.abort({ turnId })
    return true
  } catch (err) {
    S.cut = undefined
    $.ui.log(`${PLUGIN}: could not end the turn for the waiting compaction: ${errText(err)}`)
    return false
  }
}

async function startSession($: any, isInteractive: boolean): Promise<void> {
  S.settings = applyEnv(S.settings, {
    enabled: await $.env.get('SELF_COMPACT_ENABLED'),
    threshold: await $.env.get('SELF_COMPACT_THRESHOLD'),
    step: await $.env.get('SELF_COMPACT_STEP'),
  })
  if (!S.settings.enabled) return
  S.sessionId = await $.session.id()
  // SELF_COMPACT_HOME: another folder for the state files and the log, so a test session that
  // needs the real config folder for its login does not write into the real log (tests/e2e.py).
  S.stateDir = (await $.env.get('SELF_COMPACT_HOME')) || `${await configDir($)}/${PLUGIN}`
  await restoreMark($)
  if (!isInteractive) {
    try {
      const r = await $.process.run(['/bin/sh', '-c', 'ps -o args= -p "$PPID"'], { timeoutMs: 5_000 })
      S.oneShot = isOneShot(r.stdout)
    } catch {}
  }
  await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
  await $.command.register({
    name: 'compact-stats',
    description: 'self-compact: cost split, context percentiles, growth, compactions and the cheapest threshold for this session',
  })
}

// Where the next mark is due, and when the session was last compacted, survive
// a reload or a resume: they are kept in the session's state file.
async function restoreMark($: any): Promise<void> {
  try {
    const saved = JSON.parse(await $.fs.read(`${S.stateDir}/sessions/${S.sessionId}.json`))
    if (S.nextMarkAt === undefined && typeof saved?.nextMarkAt === 'number') S.nextMarkAt = saved.nextMarkAt
    if (S.lastCompactionAt === undefined && typeof saved?.lastCompactionAt === 'number') S.lastCompactionAt = saved.lastCompactionAt
  } catch {}
}

async function requestCompaction($: any, e: any): Promise<any> {
  if (e.agentId !== undefined) return { deny: 'Only the main conversation can compact itself; a subagent\'s context ends with the subagent. Nothing changed.' }
  const carry = typeof e.carry === 'string' ? e.carry : ''
  const then = typeof e.then === 'string' && e.then.trim() ? e.then : undefined
  if (!carry.trim()) return { deny: 'carry is empty: write the note to carry over (open threads, pending decisions, what you last told the user, running tasks, standing rules). Nothing changed.' }
  if (S.oneShot) return { deny: 'Compaction cannot run in a one-shot `claude -p` run: the session ends as soon as this turn ends, before a compaction could run. Nothing changed.' }
  if ((await $.env.get('DISABLE_COMPACT')) || (await $.env.get('CLAUDE_CODE_DISABLE_COMPACT'))) return { deny: 'Compaction is disabled in this session (DISABLE_COMPACT is set). Nothing changed.' }
  if (S.running) return { deny: 'A compaction is already running. Nothing changed.' }
  const replaced = !!S.pending
  const contextBefore = await readContext($)
  S.pending = { carry, then, requestedAt: Date.now(), contextBefore, held: S.pending?.held }
  await saveState($, {})
  const size = contextBefore ? ` Context now: ${contextBefore.toLocaleString('en-US')} tokens.` : ''
  return {
    result: [
      `Compaction scheduled${replaced ? ' (this replaces the earlier request)' : ''}: it runs as soon as this turn ends.${size}`,
      'End your turn now with one short line; do not start new work in this turn.',
      `After the compaction your carry note comes back word for word${then ? ', then your `then` instruction is sent as the next prompt' : ''}.`,
      'If a Stop hook such as /goal asks to keep going, the plugin ends the turn there, the compaction runs, and that hook\'s message is sent after it as the next prompt.',
    ].join(' '),
  }
}

async function endOfTurn($: any, reason: string, turnId: string): Promise<void> {
  const cut = S.cut === turnId
  S.cut = undefined
  const req = S.pending
  if (!req) return
  S.pending = undefined
  if (reason !== 'answer' && !(cut && reason === 'aborted')) {
    await saveState($, {})
    await note($, failureRow(`the turn ended with "${reason}" (interrupted or failed), so the compaction was cancelled.`, false))
    return
  }
  S.running = true
  $.clock.after(50, () => {
    void runCompaction($, req)
  })
}

async function stats($: any, args: string): Promise<{ text: string }> {
  const path = await findTranscript($)
  if (!path) return { text: 'self-compact: this session has no transcript yet.' }
  const argv = args.trim() ? args.trim().split(/\s+/) : []
  try {
    const r = await $.process.run(['/usr/bin/env', 'python3', `${$.plugin.root}/bin/self-compact-stats`, ...argv, path], { timeoutMs: 120_000 })
    return { text: (r.stdout || r.stderr).trimEnd() }
  } catch (err) {
    return { text: `self-compact: stats failed: ${errText(err)}` }
  }
}

async function withMarkOnTool($: any, e: any, ran: any): Promise<any> {
  if (e.agentId !== undefined || e.tool === TOOL_FULL || ran?.deny !== undefined) return ran
  const line = await maybeMark($)
  return line ? { ...ran, context: [...(ran.context ?? []), line] } : ran
}

async function withMarkOnPrompt($: any, e: any): Promise<any> {
  if (e.command || e.isMeta) return e
  const line = await maybeMark($)
  return line ? { ...e, context: [...(e.context ?? []), line] } : e
}

export const register: Register = (on, options) => {
  S.settings = readSettings(options)
  if (!S.settings.enabled) return

  // A /clear goes on under a new session id and transcript, with no session.start.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      S.sessionId = undefined
      S.transcriptPath = undefined
      S.nextMarkAt = undefined
      S.pending = undefined
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await startSession($, e.isInteractive)
    return next(e)
  })

  // The tool: validate, save the request, and let the turn end.
  on('tool.call', { tool: 'mcp__self-compact__compact' }, async ($, e) => requestCompaction($, e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: the request failed, nothing changed.` },
  )

  // A Stop hook that would keep the turn going does not hold a waiting compaction off.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) S.ended = undefined
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    const main = e.agentId === undefined
    if (main && S.pending && S.ended?.turnId === e.turnId && (await cutForCompaction($, e.turnId))) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    const r = yield* next(e)
    if (main) S.ended = r.toolUses.length === 0 && r.stopReason === 'end_turn' ? { turnId: e.turnId, index: e.index } : undefined
    return r
  })

  // At the end of the main loop's turn, run what was asked for.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await endOfTurn($, e.reason, e.turnId)
    return r
  })

  // The soft mark, after any tool call of the main loop...
  on('tool.call', async ($, e, next) => withMarkOnTool($, e, await next(e))).catch(($, e, next) => next(e))

  // ...and with each prompt the user sends.
  on('prompt.submit', async ($, e, next) => next(await withMarkOnPrompt($, e))).catch(($, e, next) => next(e))

  // /compact-stats: the stats script over this session's transcript.
  on('command.run', { command: 'compact-stats' }, async ($, e) => stats($, e.args ?? ''))
}
