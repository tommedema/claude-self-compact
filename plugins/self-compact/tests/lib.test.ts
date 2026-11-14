import { expect, test } from 'claude-code/testing'

import { applyEnv, boundarySince, carryRow, clockStamp, isOneShot, lastContextFromTail, markDecision, readSettings, span, summariserInstructions } from '../hooks/lib'

const call = (cr: number, cw: number, inp = 2, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: inp, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: 9 } }, ...extra })
const boundary = (ts: string) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: ts })

test('context is input + cache read + cache write of the newest main call', async () => {
  const tail = ['{"partial line', call(1000, 10), JSON.stringify({ type: 'user' }), call(300000, 12000, 5), call(1, 1, 1, { isSidechain: true })].join('\n')
  expect(lastContextFromTail(tail)).toBe(312005)
})

test('a compaction newer than every call leaves the size unknown', async () => {
  expect(lastContextFromTail([call(300000, 1), boundary('2026-11-14T00:00:00Z')].join('\n'))).toBe(undefined)
  expect(lastContextFromTail([call(300000, 1), boundary('2026-11-14T00:00:00Z'), call(20000, 30000)].join('\n'))).toBe(50002)
  expect(boundarySince(boundary('2026-11-14T00:00:01Z'), Date.parse('2026-11-14T00:00:00Z'))).toBe(true)
  expect(boundarySince(boundary('2026-11-13T00:00:00Z'), Date.parse('2026-11-14T00:00:00Z'))).toBe(false)
})

test('the mark fires once on crossing, then once per further step past the marked size', async () => {
  const s = readSettings({})
  expect(s).toEqual({ enabled: true, threshold: 250000, step: 50000 })
  let at: number | undefined
  const seen: number[] = []
  for (const ctx of [100000, 249999, 251000, 270000, 299000, 301500, 320000, 350000, 420000, 430000, 60000, 255000, 342000, 349000, 393000]) {
    const d = markDecision(ctx, at, s)
    at = d.nextAt
    if (d.mark) seen.push(ctx)
  }
  expect(seen).toEqual([251000, 301500, 420000, 255000, 342000, 393000])
})

test('one-shot runs are told apart from streaming hosts', async () => {
  expect(isOneShot('claude -p hello')).toBe(true)
  expect(isOneShot('claude --print --output-format stream-json hi')).toBe(true)
  expect(isOneShot('claude --output-format stream-json --verbose --input-format stream-json --model x')).toBe(false)
  expect(isOneShot('claude -p --input-format stream-json')).toBe(false)
  expect(isOneShot('claude --plugin-dir x')).toBe(false)
})

test('project env overrides the user options', async () => {
  const base = readSettings({ threshold: 300000 })
  expect(applyEnv(base, {})).toEqual({ enabled: true, threshold: 300000, step: 50000 })
  expect(applyEnv(base, { enabled: 'false', threshold: '120_000', step: '20000' })).toEqual({ enabled: false, threshold: 120000, step: 20000 })
  expect(applyEnv(readSettings({ enabled: false }), { enabled: '1' }).enabled).toBe(true)
  expect(applyEnv(base, { threshold: 'lots' }).threshold).toBe(300000)
})

test('the carry note comes back verbatim, with then repeated when given', async () => {
  const carry = 'line 1\n  <b>exact</b> $x `y`\nline 3'
  const row = carryRow(carry, 342853, 'go on')
  expect(row.includes(`<carry>\n${carry}\n</carry>`)).toBe(true)
  expect(row.includes('342,853 tokens')).toBe(true)
  expect(row.includes('<then>\ngo on\n</then>')).toBe(true)
  expect(carryRow(carry, undefined, undefined).includes('<then>')).toBe(false)
})

test('the row carries the machine clock and the time since the previous compaction', async () => {
  const now = new Date(2026, 10, 14, 12, 4) // local time, as the row prints it
  expect(clockStamp(now)).toBe('2026-11-14 12:04')
  expect([span(20_000), span(60_000), span(38 * 60_000), span(125 * 60_000), span(120 * 60_000)]).toEqual(['0 minutes', '1 minute', '38 minutes', '2 hours 5 minutes', '2 hours'])
  const row = carryRow('written about 13:15', 257660, undefined, { now, sincePrevMs: 38 * 60_000 })
  expect(row.includes('2026-11-14 12:04 local time, 38 minutes after the previous compaction')).toBe(true)
  expect(row.includes('<carry>\nwritten about 13:15\n</carry>')).toBe(true)
  // The first compaction of a session has no previous one to measure from.
  const first = carryRow('note', undefined, undefined, { now })
  expect(first.includes('2026-11-14 12:04 local time;')).toBe(true)
  expect(first.includes('previous compaction')).toBe(false)
})

test('the summariser is told to cover what happened after the note was written', async () => {
  const text = summariserInstructions()
  expect(text.includes('do not restate it')).toBe(true)
  expect(text.includes('went on after it')).toBe(true)
  expect(text.includes('cover all of it in full')).toBe(true)
})
