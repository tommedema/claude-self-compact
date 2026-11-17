// Pure helpers for the self-compact hooks module: no `$`, so tests can call them directly.

export const PLUGIN = 'self-compact'
export const TOOL = 'compact'
export const TOOL_FULL = `mcp__${PLUGIN}__${TOOL}`

export type Settings = { enabled: boolean; threshold: number; step: number }

export function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  return {
    enabled: options.enabled !== false,
    threshold: num(options.threshold, 250_000),
    step: num(options.step, 50_000),
  }
}

// Per-project overrides: Claude Code reads plugin options only from user, --settings
// and managed settings, so a project sets these in the `env` block of its
// .claude/settings.json (or settings.local.json) instead.
export const ENV_KEYS = { enabled: 'SELF_COMPACT_ENABLED', threshold: 'SELF_COMPACT_THRESHOLD', step: 'SELF_COMPACT_STEP' } as const

export function applyEnv(s: Settings, env: { enabled?: string; threshold?: string; step?: string }): Settings {
  const num = (v: string | undefined, d: number) => {
    const n = v === undefined ? NaN : Number(v.replace(/[_,]/g, ''))
    return Number.isFinite(n) && n > 0 ? n : d
  }
  const off = env.enabled !== undefined && /^(0|false|off|no)$/i.test(env.enabled.trim())
  const on = env.enabled !== undefined && /^(1|true|on|yes)$/i.test(env.enabled.trim())
  return {
    enabled: off ? false : on ? true : s.enabled,
    threshold: num(env.threshold, s.threshold),
    step: num(env.step, s.step),
  }
}

// The real context size of the last main-conversation model call recorded in a
// transcript chunk: input + cache read + cache write tokens of its usage.
// `text` is the tail of the transcript file; a first partial line is skipped.
// A compaction boundary newer than every call means the size is not known yet
// (the pre-compaction calls no longer describe the context).
export function lastContextFromTail(text: string): number | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (line.includes('"compact_boundary"')) {
      try {
        const row = JSON.parse(line)
        if (row?.subtype === 'compact_boundary' && !row.isSidechain) return undefined
      } catch {}
      continue
    }
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type !== 'assistant' || row.isSidechain) continue
    const u = row.message?.usage
    if (!u || row.message?.model === '<synthetic>') continue
    const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (ctx > 0) return ctx
  }
  return undefined
}

// The last report Claude wrote before it asked for the compaction: the newest
// main-conversation text of at least `minChars` characters that comes before
// its latest compact tool call in a transcript chunk (short progress lines are
// passed over). The engine keeps only the very last message word for word, and
// that is the closing line after the tool call, so the report itself would
// reach the next context only as the summariser retells it, while a reply or a
// review that arrives later quotes it by the sentence. Cut at `maxChars`.
export function lastReportFromTail(text: string, minChars = 400, maxChars = 20_000): string | undefined {
  const lines = text.split('\n')
  let called = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"assistant"') && !line.includes('"compact_boundary"')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.isSidechain) continue
    // Past an earlier compaction there is nothing the context still held.
    if (row?.subtype === 'compact_boundary') {
      if (called) return undefined
      continue
    }
    const blocks = row?.type === 'assistant' && Array.isArray(row.message?.content) ? row.message.content : []
    // In the row of the call itself only what stands before the call counts.
    let from = blocks.length - 1
    if (!called) {
      from = blocks.findLastIndex((b: any) => b?.type === 'tool_use' && b.name === TOOL_FULL) - 1
      if (from < -1) continue
      called = true
    }
    for (let j = from; j >= 0; j--) {
      const report = blocks[j]?.type === 'text' && typeof blocks[j].text === 'string' ? blocks[j].text.trim() : ''
      if (report.length >= minChars) {
        return report.length > maxChars ? `${report.slice(0, maxChars)}\n[cut here: the report went on for ${(report.length - maxChars).toLocaleString('en-US')} more characters]` : report
      }
    }
  }
  return undefined
}

// The main conversation's compactions in a transcript tail, oldest first: when
// each finished (the boundary row's time) and the sizes the engine recorded.
export function compactionsInTail(text: string): { at: number; preTokens?: number; postTokens?: number }[] {
  const found: { at: number; preTokens?: number; postTokens?: number }[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"compact_boundary"')) continue
    try {
      const row = JSON.parse(line)
      if (row?.subtype !== 'compact_boundary' || row.isSidechain) continue
      const at = Date.parse(row.timestamp)
      if (!Number.isFinite(at)) continue
      const m = row.compactMetadata ?? {}
      found.push({ at, preTokens: typeof m.preTokens === 'number' ? m.preTokens : undefined, postTokens: typeof m.postTokens === 'number' ? m.postTokens : undefined })
    } catch {}
  }
  return found
}

// The message of the newest Stop hook block in a transcript tail since `sinceMs`:
// the engine records it as a hook_blocking_error attachment and as a meta user
// row "Stop hook feedback:\n<message>".
export function stopFeedbackFromTail(text: string, sinceMs: number): string | undefined {
  let found: string | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('Stop')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.isSidechain || !(Date.parse(row?.timestamp) >= sinceMs)) continue
    const a = row.attachment
    if (row.type === 'attachment' && a?.type === 'hook_blocking_error' && a.hookEvent === 'Stop') {
      const b = a.blockingError
      const msg = typeof b === 'string' ? b : typeof b?.blockingError === 'string' ? b.blockingError : undefined
      if (msg?.trim()) found = msg.trim()
      continue
    }
    if (row.type === 'user' && row.isMeta) {
      const c = row.message?.content
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('') : ''
      const m = /^Stop hook feedback:\s*([\s\S]+)$/.exec(t.trim())
      if (m?.[1]?.trim()) found = m[1].trim()
    }
  }
  return found
}

// Soft mark: once when the context first reaches the threshold, then again only
// after it has grown a further `step` tokens past the size it was marked at.
// Returns the new `nextAt` and whether to mark now.
export function markDecision(ctx: number, nextAt: number | undefined, s: Settings): { mark: boolean; nextAt: number } {
  if (ctx < s.threshold) return { mark: false, nextAt: s.threshold }
  const at = nextAt ?? s.threshold
  if (ctx < at) return { mark: false, nextAt: at }
  return { mark: true, nextAt: ctx + s.step }
}

export function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`
}

export function markLine(ctx: number): string {
  return `self-compact plugin: this session's context is at ${kTokens(ctx)} tokens; compact at the next natural checkpoint (${TOOL_FULL}).`
}

export const TOOL_DESCRIPTION = [
  'Compact this conversation at a checkpoint you choose, instead of waiting for automatic compaction. It runs as soon as your current turn ends, so end the turn right after calling it (one short closing line).',
  '',
  'When: only at a natural checkpoint: work committed or saved, notes current, your reply to the user already sent, nothing that lives only in your context. Always before a known long idle (waiting on a long job, overnight). Never in the middle of an investigation or a multi-step change.',
  '',
  'carry: your own note, re-inserted word for word after the summary. Put in it: open threads and the next step of each; decisions pending with the user; what you last told the user; background tasks still running (ids, what they do, what to do when they finish); standing rules the user gave in this session; key paths. Complete but brief.',
  'then: optional. Sent as the next prompt after the compaction so you carry on by yourself (an unattended session). Leave it out to wait for the user.',
  '',
  'A Stop hook that keeps the turn going (such as /goal) does not hold the compaction off: the plugin ends the turn when that hook asks to go on, the compaction runs, and that hook\'s message comes back as the next prompt.',
  'If the compaction cannot be done here the call returns an error and nothing changes.',
].join('\n')

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    carry: { type: 'string', description: 'Your note to carry over verbatim: open threads, pending decisions, what you last told the user, running background tasks, standing rules.' },
    then: { type: 'string', description: 'Optional: what to continue with after the compaction, sent as the next prompt.' },
  },
  required: ['carry'],
  additionalProperties: false,
}

// What the summariser is told. The carry note itself is not repeated here: the
// summariser already reads it in the compact tool call at the end of the
// conversation, and on hosts that compact through the /compact command these
// instructions stay in the context as that command's arguments.
// The turn can go on after the tool call (a Stop hook that asks for more holds
// it open, and the compaction waits for the turn to end): what was done then is
// in nobody's note, so the summariser is told to cover it in full.
export function summariserInstructions(): string {
  return [
    'The assistant asked for this compaction itself, at a checkpoint. Its carry-over note (the carry argument of its last mcp__self-compact__compact call) is re-inserted word for word right after your summary, so do not restate it. The note does not replace your summary: write the summary in full, as you would without a note, and do not shorten it because the note exists. Keep in particular what a note of next steps tends to leave out: why each standing setting, rule and decision is as it is, what was tried and ruled out, files touched, results and numbers, and the user\'s exact requests. Read the note against the conversation: where the conversation shows something that disagrees with the note, say so plainly in the summary. Something the note says that the conversation does not mention is not a contradiction: it may come from before an earlier compaction, so leave it as it stands.',
    'The note was written at that tool call. If the conversation went on after it (more tool calls, edits, commits, replies, a hook that asked for more work), none of that is in the note: cover all of it in full, and say where it changes or contradicts the note.',
  ].join(' ')
}

// The clock at a compaction, in the machine's own time zone: "2026-11-14 12:44".
export function clockStamp(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`
}

// "38 minutes", "2 hours 5 minutes".
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (minutes < 60) return plural(minutes, 'minute')
  const rest = minutes % 60
  return plural(Math.floor(minutes / 60), 'hour') + (rest ? ` ${plural(rest, 'minute')}` : '')
}

// `then` is repeated here because something already queued (a background task's
// notification, a message the user typed) can take the first turn after the
// compaction, ahead of the submitted `then` prompt.
// `when` puts the real clock on the row: a time Claude wrote into its note is
// its own estimate and is copied forward from note to note, so the row says
// what the machine's clock read, and how long ago the previous compaction was.
// `report` is Claude's last report, word for word (lastReportFromTail).
export function carryRow(carry: string, before: number | undefined, then: string | undefined, when?: { now: Date; sincePrevMs?: number }, report?: string, held?: string): string {
  const size = before ? ` (context was ${before.toLocaleString('en-US')} tokens)` : ''
  const prev = when?.sincePrevMs !== undefined ? `, ${span(when.sincePrevMs)} after the previous compaction` : ''
  const clock = when ? ` The machine's clock at this compaction: ${clockStamp(when.now)} local time${prev}; where a time in the note disagrees, the clock is right.` : ''
  return [
    `[self-compact] This conversation was compacted at your request${size}.${clock} Your carry-over note, verbatim:`,
    '',
    '<carry>',
    carry,
    '</carry>',
    ...(report
      ? ['', 'Your last report before you asked for the compaction, word for word as you wrote it (a reply or a review that comes later may quote it by the sentence):', '', '<last-report>', report, '</last-report>']
      : []),
    ...(then
      ? ['', 'Your `then` instruction, also sent as the next prompt (if something else arrives first, carry on with it anyway; when the prompt itself arrives, do not redo work already done):', '', '<then>', then, '</then>']
      : []),
    ...(held ? ['', heldIntro(), '', '<stop-hook>', held, '</stop-hook>'] : []),
  ].join('\n')
}

// A Stop hook (such as /goal) that would have kept the turn going while a
// compaction waited for it to end: the plugin let the turn end, and passes the
// hook's message on so the session carries on as that hook asked.
function heldIntro(): string {
  return 'When you ended the turn for the compaction, a Stop hook (such as /goal) asked to keep going. The plugin let the turn end so the compaction could run, and sends that hook\'s message as the next prompt (if something else arrives first, carry on with it anyway; when the prompt itself arrives, do not redo work already done):'
}

// What is submitted after the compaction, done or not: the `then` instruction
// and the held Stop hook's message, in one prompt.
export function nextPrompt(then: string | undefined, held: string | undefined): string | undefined {
  if (!held) return then
  return [
    ...(then ? [then, ''] : []),
    'A Stop hook (such as /goal) asked to keep going when you ended the turn for the compaction; the plugin let the turn end so the compaction could run. Its message, word for word (if you already did what it asks, do not redo it):',
    '',
    '<stop-hook>',
    held,
    '</stop-hook>',
  ].join('\n')
}

export function failureRow(reason: string, hasThen: boolean, hasHeld = false): string {
  const follows = [hasThen ? 'your `then` instruction' : '', hasHeld ? 'the message of the Stop hook that asked to keep going' : ''].filter(Boolean).join(' and ')
  return [
    `[self-compact] The compaction you asked for did not happen: ${reason}`,
    'The conversation is unchanged, so nothing was lost. Do not ask again in this turn.',
    ...(follows ? [`${follows.charAt(0).toUpperCase()}${follows.slice(1)} follow${hasThen && hasHeld ? '' : 's'} as the next prompt.`] : []),
  ].join('\n')
}

// One-shot headless runs (claude -p without stream-json input) end the session
// right after the turn, before a compaction could run.
export function isOneShot(argv: string): boolean {
  const printing = /(^|\s)(-p|--print)(\s|$)/.test(argv)
  const streaming = /--input-format(=|\s+)stream-json/.test(argv)
  return printing && !streaming
}
