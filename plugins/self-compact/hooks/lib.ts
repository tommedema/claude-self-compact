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

// Whether a compact_boundary row newer than `sinceMs` is in the transcript tail.
export function boundarySince(text: string, sinceMs: number): boolean {
  for (const line of text.split('\n')) {
    if (!line.includes('"compact_boundary"')) continue
    try {
      const row = JSON.parse(line)
      if (row?.subtype === 'compact_boundary' && Date.parse(row.timestamp) >= sinceMs) return true
    } catch {}
  }
  return false
}

// Soft mark: once when the context first reaches the threshold, then again only
// each further `step` tokens. Returns the new `nextAt` and whether to mark now.
export function markDecision(ctx: number, nextAt: number | undefined, s: Settings): { mark: boolean; nextAt: number } {
  if (ctx < s.threshold) return { mark: false, nextAt: s.threshold }
  const at = nextAt ?? s.threshold
  if (ctx < at) return { mark: false, nextAt: at }
  return { mark: true, nextAt: s.threshold + (Math.floor((ctx - s.threshold) / s.step) + 1) * s.step }
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
export function summariserInstructions(): string {
  return 'The assistant asked for this compaction itself, at a checkpoint. Its carry-over note (the carry argument of its last mcp__self-compact__compact call) is re-inserted word for word right after your summary, so do not restate it: keep the summary short and cover what the note leaves out (files touched, results and numbers, the user\'s exact recent requests).'
}

export function carryRow(carry: string, before: number | undefined, hasThen: boolean): string {
  const size = before ? ` (context was ${before.toLocaleString('en-US')} tokens)` : ''
  return [
    `[self-compact] This conversation was compacted at your request${size}. Your carry-over note, verbatim:`,
    '',
    '<carry>',
    carry,
    '</carry>',
    ...(hasThen ? ['', 'Your `then` instruction follows as the next prompt.'] : []),
  ].join('\n')
}

export function failureRow(reason: string, hasThen: boolean): string {
  return [
    `[self-compact] The compaction you asked for did not happen: ${reason}`,
    'The conversation is unchanged, so nothing was lost. Do not ask again in this turn.',
    ...(hasThen ? ['Your `then` instruction follows as the next prompt.'] : []),
  ].join('\n')
}

// One-shot headless runs (claude -p without stream-json input) end the session
// right after the turn, before a compaction could run.
export function isOneShot(argv: string): boolean {
  const printing = /(^|\s)(-p|--print)(\s|$)/.test(argv)
  const streaming = /--input-format(=|\s+)stream-json/.test(argv)
  return printing && !streaming
}
