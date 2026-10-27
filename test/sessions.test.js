const test = require('node:test')
const assert = require('node:assert')
const { createTracker, track } = require('../src/sessions')

const NOW = 1_000_000_000

test('what is on disk at start is not announced', () => {
  const tracker = createTracker()
  const sessions = [
    { id: 'a', updatedAt: NOW, wait: { kind: 'question', tool: 'AskUserQuestion', since: NOW - 5 }, turn: { id: 't1', at: NOW, deltas: { five_hour: 3 } } },
  ]
  const first = track(tracker, sessions, NOW)
  assert.deepStrictEqual(first.newWaits, [])
  assert.deepStrictEqual(first.newTurns, [])
  assert.strictEqual(first.active.length, 1, 'an open wait still shows')
})

test('a new wait is announced once and stays active until it closes', () => {
  const tracker = createTracker()
  track(tracker, [{ id: 'a', updatedAt: NOW, wait: null, turn: null }], NOW)
  const waiting = [{ id: 'a', updatedAt: NOW + 1, wait: { kind: 'approval', tool: 'Bash', since: NOW + 1 }, turn: null }]
  assert.strictEqual(track(tracker, waiting, NOW + 2).newWaits.length, 1)
  const again = track(tracker, waiting, NOW + 3)
  assert.strictEqual(again.newWaits.length, 0)
  assert.strictEqual(again.active.length, 1)
  const done = track(tracker, [{ id: 'a', updatedAt: NOW + 4, wait: null, turn: null }], NOW + 5)
  assert.deepStrictEqual(done.active, [])
})

test('a session that stopped writing long ago is not waiting', () => {
  const tracker = createTracker()
  const stale = [{ id: 'a', updatedAt: NOW - 31 * 60 * 1000, wait: { kind: 'question', tool: 'AskUserQuestion', since: NOW - 31 * 60 * 1000 } }]
  assert.deepStrictEqual(track(tracker, stale, NOW).active, [])
})

test('a finished turn is announced only when a window moved', () => {
  const tracker = createTracker()
  track(tracker, [{ id: 'a', updatedAt: NOW, wait: null, turn: null }], NOW)
  const zero = track(tracker, [{ id: 'a', updatedAt: NOW, turn: { id: 't1', at: NOW, deltas: { five_hour: 0, seven_day: 0 } } }], NOW + 1)
  assert.deepStrictEqual(zero.newTurns, [])
  const moved = track(tracker, [{ id: 'a', updatedAt: NOW, turn: { id: 't2', at: NOW, deltas: { five_hour: 2, seven_day: 0 } } }], NOW + 2)
  assert.strictEqual(moved.newTurns.length, 1)
  assert.deepStrictEqual(moved.newTurns[0].deltas, { five_hour: 2, seven_day: 0 })
  const same = track(tracker, [{ id: 'a', updatedAt: NOW, turn: { id: 't2', at: NOW, deltas: { five_hour: 2 } } }], NOW + 3)
  assert.deepStrictEqual(same.newTurns, [], 'the same turn is not announced twice')
})

test('an old turn found later is not announced', () => {
  const tracker = createTracker()
  track(tracker, [], NOW)
  const late = track(tracker, [{ id: 'b', updatedAt: NOW, turn: { id: 't1', at: NOW - 5 * 60 * 1000, deltas: { five_hour: 4 } } }], NOW)
  assert.deepStrictEqual(late.newTurns, [])
})
