// Reads what the plugin writes for each Claude Code session (whale/sessions/<id>.json) and works out what
// the widget should tell the person: which sessions are waiting on them, and which turns just finished.
//
// A session file is { updatedAt, wait: { kind, tool, since } | null, turn: { id, at, deltas } | null }.

const fs = require('fs')
const path = require('path')

// A session that stopped writing this long ago is not waiting any more (it was closed or crashed)
const WAIT_STALE_MS = 30 * 60 * 1000
// A finished turn is only worth telling about right after it ends, not when the widget starts later
const TURN_FRESH_MS = 60 * 1000
// Session files are removed after a week without changes
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

function read(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const sessions = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const file = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      sessions.push({ id: name.slice(0, -'.json'.length), ...file })
    } catch {
      // Half-written or removed while reading; the next scan sees it whole
    }
  }
  return sessions
}

function removeOld(dir, now = Date.now()) {
  for (const session of read(dir)) {
    if (now - (session.updatedAt || 0) > KEEP_MS) fs.rmSync(path.join(dir, `${session.id}.json`), { force: true })
  }
}

function createTracker() {
  return { primed: false, waits: new Set(), turns: new Map() }
}

/**
 * Compares the sessions with what the tracker saw last time. Returns
 *   active: every wait still open, oldest first
 *   newWaits: waits that opened since the last call
 *   newTurns: turns that finished since the last call and moved a window by at least 1%
 * The first call only learns what is there, so nothing already on disk is announced as new.
 */
function track(tracker, sessions, now = Date.now()) {
  const active = []
  const newWaits = []
  const newTurns = []
  const completedTurns = []
  const openKeys = new Set()
  for (const s of sessions) {
    const host = s.host || 'claude'
    if (s.wait && now - (s.updatedAt || 0) < WAIT_STALE_MS) {
      const key = `${host}:${s.id}:${s.wait.since}`
      const wait = { ...s.wait, session: s.id, host }
      openKeys.add(key)
      active.push(wait)
      if (tracker.primed && !tracker.waits.has(key)) newWaits.push(wait)
    }
    const turnKey = `${host}:${s.id}`
    if (s.turn && tracker.turns.get(turnKey) !== s.turn.id) {
      tracker.turns.set(turnKey, s.turn.id)
      const fresh = tracker.primed && now - s.turn.at < TURN_FRESH_MS
      if (fresh) {
        const turn = { ...s.turn, session: s.id, host }
        completedTurns.push(turn)
        const moved = Object.values(s.turn.deltas || {}).some(d => d > 0)
        if (moved) newTurns.push(turn)
      }
    }
  }
  tracker.waits = openKeys
  tracker.primed = true
  active.sort((a, b) => a.since - b.since)
  return { active, newWaits, newTurns, completedTurns }
}

module.exports = { read, removeOld, createTracker, track }
