const test = require('node:test')
const assert = require('node:assert')
const { fromWeb, merge } = require('../src/limits')

test('fromWeb keeps the shown windows and skips empty ones', () => {
  const limits = fromWeb({
    five_hour: { utilization: 41, resets_at: '2026-10-27T11:20:00.512345+00:00' },
    seven_day: { utilization: 36.5, resets_at: '2026-11-01T15:00:00+00:00' },
    seven_day_opus: { utilization: 3, resets_at: null },
    extra_usage: null,
  })
  assert.deepStrictEqual(limits, [
    { kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-27T11:20:00.512Z' },
    { kind: 'seven_day', percentUsed: 36.5, resetsAt: '2026-11-01T15:00:00.000Z' },
  ])
  assert.deepStrictEqual(fromWeb({ five_hour: null }), [])
})

const file = {
  updatedAt: 1000,
  limits: [
    { kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-27T11:20:00.000Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-01T15:00:00.000Z' },
    { kind: 'spend_limit', percentUsed: 5 },
  ],
  sessionCostUsd: 2,
}

test('merge takes the higher reading within the same window', () => {
  const web = {
    at: 2000,
    limits: [
      { kind: 'five_hour', percentUsed: 38, resetsAt: '2026-10-27T11:20:00.400Z' },
      { kind: 'seven_day', percentUsed: 35, resetsAt: '2026-11-01T15:00:00.000Z' },
    ],
  }
  const merged = merge(file, web)
  assert.strictEqual(merged.updatedAt, 2000)
  assert.strictEqual(merged.sessionCostUsd, 2)
  assert.deepStrictEqual(merged.limits.map(l => l.percentUsed), [38, 40, 5])
})

test('merge lets the newer source win after a reset', () => {
  const web = { at: 2000, limits: [{ kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-27T16:20:00.000Z' }] }
  assert.strictEqual(merge(file, web).limits[0].percentUsed, 2)
  assert.strictEqual(merge(file, { ...web, at: 500 }).limits[0].percentUsed, 30)
})

test('merge works with only one source', () => {
  const web = { at: 2000, limits: [{ kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-27T16:20:00.000Z' }] }
  assert.deepStrictEqual(merge(null, web), { updatedAt: 2000, limits: web.limits })
  assert.strictEqual(merge(file, null), file)
  assert.strictEqual(merge(file, { at: 1, limits: [] }), file)
})
