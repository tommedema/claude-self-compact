import { expect, test } from 'claude-code/testing'

import { applyEnv, boundarySince, isOneShot, lastContextFromTail, markDecision, readSettings } from '../hooks/lib'

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

test('the mark fires once on crossing, then once per further step', async () => {
  const s = readSettings({})
  expect(s).toEqual({ enabled: true, threshold: 250000, step: 50000 })
  let at: number | undefined
  const seen: number[] = []
  for (const ctx of [100000, 249999, 251000, 270000, 299000, 300500, 320000, 420000, 430000, 60000, 255000]) {
    const d = markDecision(ctx, at, s)
    at = d.nextAt
    if (d.mark) seen.push(ctx)
  }
  expect(seen).toEqual([251000, 300500, 420000, 255000])
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
