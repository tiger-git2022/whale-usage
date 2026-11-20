'use strict'

// Antigravity lifecycle hook bridge for Whale Usage.
// Compatible with Node.js 14+ (zero external dependencies).
//
// Reads the hook payload JSON from stdin and updates files under ~/.gemini/antigravity/whale/:
//   state.json             latest active modelName and conversationId
//   sessions/<id>.json     waiting state (ask_question) and finished-turn marker/deltas
//
// Always writes a valid JSON object to stdout and never throws, so the agent loop is never blocked.

const fs = require('fs')
const os = require('os')
const path = require('path')

function whaleDir() {
  if (process.env.ANTIGRAVITY_WHALE_DIR) return process.env.ANTIGRAVITY_WHALE_DIR
  return path.join(os.homedir(), '.gemini', 'antigravity', 'whale')
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  try {
    fs.renameSync(tmp, file)
  } catch (_) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    try {
      fs.unlinkSync(tmp)
    } catch (__) {}
  }
}

function safeId(id) {
  const clean = String(id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
  return clean.slice(0, 96) || 'default'
}

// Extracts rounded percentUsed readings keyed by "<groupId>:<kind>" from usage.json if present.
function readUsagePercents(dir) {
  const usage = readJson(path.join(dir, 'usage.json'))
  if (!usage || typeof usage !== 'object') return {}
  const out = {}
  if (Array.isArray(usage.groups)) {
    for (let i = 0; i < usage.groups.length; i++) {
      const g = usage.groups[i]
      if (!g || !Array.isArray(g.limits)) continue
      for (let j = 0; j < g.limits.length; j++) {
        const l = g.limits[j]
        if (l && typeof l.percentUsed === 'number') {
          out[`${g.id || 'group'}:${l.kind || 'five_hour'}`] = Math.round(l.percentUsed)
        }
      }
    }
  } else if (Array.isArray(usage.limits)) {
    for (let i = 0; i < usage.limits.length; i++) {
      const l = usage.limits[i]
      if (l && typeof l.percentUsed === 'number') {
        out[l.kind || 'five_hour'] = Math.round(l.percentUsed)
      }
    }
  }
  return out
}

function handleEvent(payload, now) {
  const dir = whaleDir()
  const event = payload && payload.hookEventName ? String(payload.hookEventName) : ''
  const convId = safeId(payload && payload.conversationId)
  const modelName = payload && typeof payload.modelName === 'string' ? payload.modelName.trim() : ''

  // Record active model whenever Antigravity reports one
  if (modelName) {
    const stateFile = path.join(dir, 'state.json')
    const prev = readJson(stateFile) || {}
    const shouldWrite =
      modelName.toLowerCase() !== 'auto' || !prev.modelName || prev.conversationId !== convId
    if (shouldWrite) {
      writeJson(stateFile, {
        updatedAt: now,
        modelName: modelName,
        conversationId: convId,
      })
    }
  }

  const sessionFile = path.join(dir, 'sessions', `${convId}.json`)
  const session = readJson(sessionFile) || {
    updatedAt: 0,
    host: 'antigravity',
    wait: null,
    turn: null,
    turnStart: null,
  }
  session.host = 'antigravity'

  if (event === 'SessionStart') {
    session.wait = null
    session.turnStart = null
    session.updatedAt = now
    writeJson(sessionFile, session)
    return {}
  }

  if (event === 'PreInvocation') {
    const inv = typeof payload.invocationNum === 'number' ? payload.invocationNum : 0
    if (!session.turnStart || inv <= 1) {
      session.turnStart = { at: now, percents: readUsagePercents(dir) }
      session.updatedAt = now
      writeJson(sessionFile, session)
    }
    return {}
  }

  if (event === 'PreToolUse') {
    const toolName = (payload.toolCall && payload.toolCall.name) || 'ask_question'
    session.wait = { kind: 'question', tool: String(toolName), since: now }
    session.updatedAt = now
    writeJson(sessionFile, session)
    return { decision: 'allow' }
  }

  if (event === 'PostToolUse') {
    if (session.wait) {
      session.wait = null
      session.updatedAt = now
      writeJson(sessionFile, session)
    }
    return {}
  }

  if (event === 'Stop') {
    session.wait = null
    const reason = String(payload.terminationReason || '')
    const before = session.turnStart && session.turnStart.percents ? session.turnStart.percents : null
    session.turnStart = null

    if (reason === 'NO_TOOL_CALL' || reason === '') {
      const after = readUsagePercents(dir)
      const deltas = {}
      if (before) {
        const keys = Object.keys(after)
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]
          if (typeof before[k] === 'number' && after[k] >= before[k]) {
            deltas[k] = after[k] - before[k]
          }
        }
      }
      const execNum = typeof payload.executionNum === 'number' ? payload.executionNum : 0
      session.turn = {
        id: `ag-${now}-${execNum}`,
        at: now,
        deltas: deltas,
        modelName: modelName || null,
        host: 'antigravity',
      }
    }
    session.updatedAt = now
    writeJson(sessionFile, session)
    return {}
  }

  return {}
}

function main() {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    raw += chunk
  })
  process.stdin.on('end', () => {
    let result = {}
    try {
      const payload = raw.trim() ? JSON.parse(raw) : {}
      result = handleEvent(payload, Date.now())
    } catch (_) {
      result = {}
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  })
}

if (require.main === module) {
  main()
}

module.exports = { handleEvent, readUsagePercents }
