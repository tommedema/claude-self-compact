// self-compact: lets Claude compact its own session at a checkpoint it picks.
//
// - Registers the tool mcp__self-compact__compact({ carry, then? }). The call only
//   schedules: compaction cannot run under the turn that made the call, so it runs
//   as soon as that turn ends (turn.complete), through $.session.compact where the
//   engine offers it (interactive terminal) and through the built-in /compact
//   command elsewhere (the desktop app, Agent SDK hosts), which run it as a turn.
// - After the compaction the carry note is appended verbatim as a user-role row,
//   and `then`, if given, is submitted as the next prompt.
// - A soft mark: after tool calls and user prompts, the real context size of the
//   last call is read from the transcript; past the threshold Claude gets one
//   line, once, then again only every further `step` tokens. It never blocks.
import type { Register } from 'claude-code'
import {
  INPUT_SCHEMA, PLUGIN, TOOL, TOOL_DESCRIPTION, TOOL_FULL,
  applyEnv, boundarySince, carryRow, failureRow, isOneShot, lastContextFromTail, markDecision,
  markLine, readSettings, summariserInstructions,
} from './lib'
import type { Settings } from './lib'

type Request = { carry: string; then?: string; requestedAt: number; contextBefore?: number }
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
  inFlight?: { instructions: string } // running through the /compact command
  hookOutcome?: Outcome
  nextMarkAt?: number
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
    const id = S.sessionId ?? (await $.session.id())
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

async function saveState($: any, extra: Record<string, unknown>): Promise<void> {
  if (!S.stateDir || !S.sessionId) return
  const state = { sessionId: S.sessionId, transcriptPath: S.transcriptPath, nextMarkAt: S.nextMarkAt, pending: S.pending ?? null, ...extra }
  try {
    await $.fs.write(`${S.stateDir}/sessions/${S.sessionId}.json`, JSON.stringify(state, null, 2) + '\n')
  } catch {}
}

async function appendLog($: any, entry: Record<string, unknown>): Promise<void> {
  if (!S.stateDir) return
  const path = `${S.stateDir}/compactions.jsonl`
  let old = ''
  try { old = await $.fs.read(path) } catch {}
  try { await $.fs.write(path, old + JSON.stringify(entry) + '\n') } catch {}
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
  S.inFlight = { instructions }
  S.hookOutcome = undefined
  try {
    await $.command.run({ command: 'compact', args: instructions })
    if (S.hookOutcome) return S.hookOutcome
    const path = await findTranscript($)
    const text = path ? await tail($, path, 4_000_000) : undefined
    return text && boundarySince(text, startedAt)
      ? { ok: true, via: '/compact' }
      : { ok: false, via: '/compact', reason: 'the /compact command ran but did not compact the conversation' }
  } catch (err) {
    return { ok: false, via: '/compact', reason: `${errText(err)} (and $.session.compact: ${first})` }
  } finally {
    S.inFlight = undefined
  }
}

async function runCompaction($: any, req: Request): Promise<void> {
  const instructions = summariserInstructions()
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
    await note($, carryRow(req.carry, req.contextBefore, req.then))
  } else {
    await note($, failureRow(outcome.reason, !!req.then))
  }
  S.running = false
  await saveState($, { last: { ...outcome, requestedAt: req.requestedAt, finishedAt: Date.now() } })
  await appendLog($, {
    at: new Date().toISOString(), sessionId: S.sessionId, transcriptPath: S.transcriptPath, ...outcome,
    contextBefore: req.contextBefore, requestedAt: new Date(req.requestedAt).toISOString(),
    durationMs: Date.now() - startedAt, carryChars: req.carry.length, hasThen: !!req.then,
  })
  if (req.then) {
    try {
      await $.prompt.submit({ text: req.then })
    } catch (err) {
      $.ui.log(`${PLUGIN}: could not submit the then prompt: ${errText(err)}`)
    }
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
  S.stateDir = `${await configDir($)}/${PLUGIN}`
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

// Where the next mark is due survives a reload or a resume: it is kept in the
// session's state file.
async function restoreMark($: any): Promise<void> {
  if (S.nextMarkAt !== undefined) return
  try {
    const saved = JSON.parse(await $.fs.read(`${S.stateDir}/sessions/${S.sessionId}.json`))
    if (typeof saved?.nextMarkAt === 'number') S.nextMarkAt = saved.nextMarkAt
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
  S.pending = { carry, then, requestedAt: Date.now(), contextBefore }
  await saveState($, {})
  const size = contextBefore ? ` Context now: ${contextBefore.toLocaleString('en-US')} tokens.` : ''
  return {
    result: [
      `Compaction scheduled${replaced ? ' (this replaces the earlier request)' : ''}: it runs as soon as this turn ends.${size}`,
      'End your turn now with one short line; do not start new work in this turn.',
      `After the compaction your carry note comes back word for word${then ? ', then your `then` instruction is sent as the next prompt' : ''}.`,
    ].join(' '),
  }
}

async function endOfTurn($: any, reason: string): Promise<void> {
  const req = S.pending
  if (!req) return
  S.pending = undefined
  if (reason !== 'answer') {
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

  // The transcript path, from the classic SessionStart event (startup, resume, clear, compact).
  on('classic.SessionStart' as any, async ($: any, e: any, next: any) => {
    if (typeof e?.transcript_path === 'string') S.transcriptPath = e.transcript_path
    if (e?.source === 'compact' || e?.source === 'clear') S.nextMarkAt = undefined
    return next(e)
  }).catch(($: any, e: any, next: any) => next(e))

  on('session.start', async ($, e, next) => {
    await startSession($, e.isInteractive)
    return next(e)
  })

  // The tool: validate, save the request, and let the turn end.
  on('tool.call', { tool: 'mcp__self-compact__compact' }, async ($, e) => requestCompaction($, e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: the request failed, nothing changed.` },
  )

  // At the end of the main loop's turn, run what was asked for.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await endOfTurn($, e.reason)
    return r
  })

  // Learn the outcome of a /compact this plugin started; any compaction resets the mark.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    const mine = S.inFlight !== undefined && e.instructions === S.inFlight.instructions
    try {
      const c: any = await next(e)
      const ok = c?.skip === undefined
      if (mine) {
        S.hookOutcome = ok
          ? { ok: true, via: '/compact', tokensBefore: c?.tokensBefore, tokensAfter: c?.tokensAfter, usage: c?.usage }
          : { ok: false, via: '/compact', reason: String(c.skip) }
      } else if (ok) {
        await appendLog($, { at: new Date().toISOString(), sessionId: S.sessionId, transcriptPath: S.transcriptPath, ok: true, via: e.trigger, tokensBefore: c?.tokensBefore, tokensAfter: c?.tokensAfter, usage: c?.usage })
      }
      if (ok) {
        S.nextMarkAt = undefined
        if (!mine) await saveState($, {})
      }
      return c
    } catch (err) {
      if (mine) S.hookOutcome = { ok: false, via: '/compact', reason: errText(err) }
      throw err
    }
  }).catch(($, e, next) => next(e))

  // The soft mark, after any tool call of the main loop...
  on('tool.call', async ($, e, next) => withMarkOnTool($, e, await next(e))).catch(($, e, next) => next(e))

  // ...and with each prompt the user sends.
  on('prompt.submit', async ($, e, next) => next(await withMarkOnPrompt($, e))).catch(($, e, next) => next(e))

  // /compact-stats: the stats script over this session's transcript.
  on('command.run', { command: 'compact-stats' }, async ($, e) => stats($, e.args ?? ''))
}
