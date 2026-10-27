import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Shares the account's rate-limit windows with the Whale Usage desktop widget, and tells it when a
// session is waiting for the person (a question, an approval) and how much a finished turn used.
//
//   whale/usage.json             the latest windows; every session writes the same account-wide numbers
//   whale/sessions/<id>.json     this session's state: { updatedAt, wait, turn }
//
// The widget watches both and keeps no state here: a session file is the whole truth for its session.

type Snapshot = {
  updatedAt: number
  limits: SessionRateLimit[]
  sessionCostUsd?: number
}

type Wait = { kind: 'question' | 'approval'; tool: string; since: number }

type SessionFile = {
  updatedAt: number
  // What the session is waiting on the person for, or null
  wait: Wait | null
  // The last finished turn of the main conversation: how many points each window rose during it
  turn: { id: string; at: number; deltas: Record<string, number> } | null
}

// What this session's hooks remember between events; a reload starts it over, which only forgets a
// wait in progress.
type Session = {
  file: SessionFile
  // Open waits, newest last, keyed `call:<tool_use_id>`, `request:<n>` or NOTICE_KEY
  waits: Map<string, Wait>
  requests: number // permission requests seen, to key each one
  turnStart: Map<string, Record<string, number>> // each window's percent when a turn began, by turnId
}

// Tools that always stop and ask the person
const QUESTION_TOOLS = new Set(['AskUserQuestion'])
const PLAN_TOOLS = new Set(['ExitPlanMode'])
const NOTICE_KEY = 'notice'

async function whaleDir($: EngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) return `${configDir}/whale`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return `${home}/.claude/whale`
}

async function saveUsage($: EngineInterface, limits: SessionRateLimit[], sessionCostUsd?: number) {
  if (limits.length === 0) return
  const snapshot: Snapshot = { updatedAt: await $.clock.now(), limits, sessionCostUsd }
  await $.fs.write(`${await whaleDir($)}/usage.json`, JSON.stringify(snapshot, null, 2))
}

// Each window's percent as the widget shows it (whole numbers), by kind
async function percents($: EngineInterface): Promise<Record<string, number>> {
  const usage = await $.session.usage()
  const out: Record<string, number> = {}
  for (const limit of usage.rateLimits) out[limit.kind] = Math.round(limit.percentUsed)
  return out
}

async function saveSession($: EngineInterface, s: Session) {
  s.file.wait = [...s.waits.values()].pop() ?? null
  s.file.updatedAt = await $.clock.now()
  const id = await $.session.id()
  await $.fs.write(`${await whaleDir($)}/sessions/${id}.json`, JSON.stringify(s.file, null, 2))
}

async function startWait($: EngineInterface, s: Session, key: string, kind: Wait['kind'], tool: string) {
  if (s.waits.has(key)) return
  s.waits.set(key, { kind, tool, since: await $.clock.now() })
  await saveSession($, s)
}

// Ends the waits of a call that finished: its own (a question, a plan), else the oldest permission
// request for the same tool (a request carries no call id), and a permission notice, which names no tool.
async function endWait($: EngineInterface, s: Session, key: string, tool: string) {
  let changed = s.waits.delete(key)
  if (!changed) {
    const request = [...s.waits].find(([k, w]) => k.startsWith('request:') && w.tool === tool)
    if (request) changed = s.waits.delete(request[0])
  }
  if (s.waits.delete(NOTICE_KEY)) changed = true
  if (changed) await saveSession($, s)
}

// Records how much each window rose during a finished turn of the main conversation
async function finishTurn($: EngineInterface, s: Session, turnId: string, answered: boolean) {
  const before = s.turnStart.get(turnId)
  s.turnStart.delete(turnId)
  s.waits.clear()
  if (before && answered) {
    const after = await percents($)
    const deltas: Record<string, number> = {}
    for (const [kind, now] of Object.entries(after)) {
      const then = before[kind]
      // A window that reset during the turn has no meaningful rise
      if (then !== undefined && now >= then) deltas[kind] = now - then
    }
    s.file.turn = { id: turnId, at: await $.clock.now(), deltas }
  }
  await saveSession($, s)
}

export const register: Register = on => {
  const s: Session = { file: { updatedAt: 0, wait: null, turn: null }, waits: new Map(), requests: 0, turnStart: new Map() }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const usage = await $.session.usage()
    await saveUsage($, usage.rateLimits, usage.cost?.usd)
    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await saveUsage($, e.rateLimits, e.cost?.usd)
    return next(e)
  })

  // A permission dialog is about to be shown for a call
  on('classic.PermissionRequest', async ($, e, next) => {
    s.requests += 1
    await startWait($, s, `request:${s.requests}`, 'approval', e.tool_name)
    return next(e)
  })

  // Some hosts announce a permission prompt only as a notification
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') await startWait($, s, NOTICE_KEY, 'approval', '')
    return next(e)
  })

  // Questions and plan approvals wait on the person for as long as the call runs; any other call
  // that waited for a permission dialog is done waiting once it has run or been refused.
  on('tool.call', async ($, e, next) => {
    const key = `call:${e.tool_use_id ?? e.tool}`
    if (QUESTION_TOOLS.has(e.tool)) await startWait($, s, key, 'question', e.tool)
    else if (PLAN_TOOLS.has(e.tool)) await startWait($, s, key, 'approval', e.tool)
    try {
      return await next(e)
    } finally {
      await endWait($, s, key, e.tool)
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) s.turnStart.set(e.turnId, await percents($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await finishTurn($, s, e.turnId, e.reason === 'answer')
    return result
  })
}
