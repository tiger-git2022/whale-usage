// Antigravity quota protocol, model-to-group mapping, and optional external CLI polling.
//
// Reads two local sources and merges them into a unified multi-group usage object (all percents are
// normalized to percentUsed 0..100 so alerts and colors match the Claude widget):
//   1. ~/.gemini/antigravity/whale/usage.json   standard multi-group usage file (or custom script output)
//   2. External quota command (default: `antigravity-usage quota --json`) run periodically and after turns
//
// Current model detection combines:
//   - UI Automation text near Antigravity's input box (instant, even before sending a message)
//   - ~/.gemini/antigravity/whale/state.json written by the official Antigravity hooks plugin

const { exec, execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const log = require('./log')

const DEFAULT_COMMAND = 'antigravity-usage quota --json --refresh'
const DEFAULT_INTERVAL_SEC = 60
const MISSING_RETRY_MS = 5 * 60 * 1000
const ERROR_RETRY_MS = 2 * 60 * 1000
const CMD_TIMEOUT_MS = 15 * 1000
const REFRESH_COOLDOWN_MS = 5 * 1000

const GROUP_META = {
  gemini_pro: { id: 'gemini_pro', label: 'Gemini Pro', shortLabel: 'Pro', color: 'gemini', order: 0 },
  gemini_flash: { id: 'gemini_flash', label: 'Gemini Flash', shortLabel: 'Flash', color: 'flash', order: 1 },
  gemini: { id: 'gemini', label: 'Gemini', shortLabel: 'Gem', color: 'gemini', order: 0 },
  claude: { id: 'claude', label: 'Claude', shortLabel: 'Cla', color: 'claude', order: 2 },
  gpt: { id: 'gpt', label: 'GPT', shortLabel: 'GPT', color: 'gpt', order: 3 },
  third_party: { id: 'third_party', label: 'Claude / 第三方', shortLabel: '3P', color: 'claude', order: 2 },
  other: { id: 'other', label: '其他模型', shortLabel: 'Other', color: 'other', order: 9 },
}

const WINDOW_LABELS = {
  five_hour: '5 小时',
  seven_day: '本周',
  quota: '周期额度',
}

function whaleDir() {
  if (process.env.ANTIGRAVITY_WHALE_DIR) return process.env.ANTIGRAVITY_WHALE_DIR
  return path.join(os.homedir(), '.gemini', 'antigravity', 'whale')
}

const usagePath = () => path.join(whaleDir(), 'usage.json')
const statePath = () => path.join(whaleDir(), 'state.json')
const sessionsDir = () => path.join(whaleDir(), 'sessions')

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10
}

function normalizeIso(value) {
  if (!value) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

// Extracts percentUsed (0..100) from any common field name (including antigravity-usage's
// 0..1 `remainingPercentage` and `isExhausted`).
function extractPercentUsed(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.percentUsed === 'number') return clampPercent(entry.percentUsed)
  if (typeof entry.usedPercent === 'number') return clampPercent(entry.usedPercent)
  if (typeof entry.utilization === 'number') return clampPercent(entry.utilization)
  if (typeof entry.usedFraction === 'number') return clampPercent(entry.usedFraction * 100)
  if (typeof entry.usedPercentage === 'number') {
    return clampPercent(entry.usedPercentage <= 1 ? entry.usedPercentage * 100 : entry.usedPercentage)
  }
  if (typeof entry.remainingPercentage === 'number') {
    return clampPercent(entry.remainingPercentage <= 1 ? (1 - entry.remainingPercentage) * 100 : 100 - entry.remainingPercentage)
  }
  if (typeof entry.remainingPercent === 'number') return clampPercent(100 - entry.remainingPercent)
  if (typeof entry.remaining_percent === 'number') return clampPercent(100 - entry.remaining_percent)
  if (typeof entry.remainingFraction === 'number') return clampPercent((1 - entry.remainingFraction) * 100)
  if (typeof entry.remaining_fraction === 'number') return clampPercent((1 - entry.remaining_fraction) * 100)
  if (typeof entry.remaining === 'number') {
    return clampPercent(entry.remaining <= 1 ? (1 - entry.remaining) * 100 : 100 - entry.remaining)
  }
  if (entry.isExhausted === true) return 100
  return null
}

// Maps any model name or bucket identifier into a normalized quota group id.
function classifyModel(name) {
  if (!name || typeof name !== 'string') return null
  const text = name.trim().toLowerCase()
  if (!text || text === 'auto' || text === 'default') return null

  if (/\b(claude|sonnet|opus|haiku|anthropic)\b/.test(text) || text.includes('claude')) return 'claude'
  if (/\b(3p|third[_\-\s]?party)\b/.test(text) || /^3p\b/.test(text)) return 'third_party'
  if (/\b(gpt|openai|o1|o3|o4|codex)\b/.test(text) || text.includes('gpt-')) return 'gpt'
  if (text.includes('gemini')) {
    if (/\b(flash|lite|nano)\b/.test(text) || text.includes('flash')) return 'gemini_flash'
    if (/\b(pro|ultra|high|neon|next|thinking|preview|2\.5|3|4)\b/.test(text)) return 'gemini_pro'
    return 'gemini'
  }
  if (/\b(flash|lite)\b/.test(text)) return 'gemini_flash'
  return null
}

// Classifies a quota bucket identifier from CLI/JSON output (distinguishing generic `gemini-5h`
// from explicit `gemini-pro` / `gemini-flash`).
function classifyBucket(name) {
  if (!name || typeof name !== 'string') return 'other'
  const text = name.trim().toLowerCase()
  if (GROUP_META[text]) return text
  if (/^gemini([_\-\s]?(5h|7d|daily|weekly|quota|all|pool))?$/.test(text)) return 'gemini'
  const byModel = classifyModel(text)
  return byModel ?? 'other'
}

function inferWindowKind(name, explicitKind) {
  const raw = String(explicitKind || name || '').toLowerCase()
  if (raw.includes('seven_day') || raw.includes('weekly') || /\b(7d|week)\b/.test(raw) || raw.endsWith('-7d') || raw.endsWith('_7d')) {
    return 'seven_day'
  }
  if (raw.includes('five_hour') || raw.includes('hourly') || /\b(5h|hour)\b/.test(raw) || raw.endsWith('-5h') || raw.endsWith('_5h')) {
    return 'five_hour'
  }
  return explicitKind ? String(explicitKind) : 'five_hour'
}

function groupMetaFor(id, overrides = {}) {
  const base = GROUP_META[id] || {
    id,
    label: overrides.label || id,
    shortLabel: (overrides.label || id).slice(0, 4),
    color: 'other',
    order: 8,
  }
  return {
    id: base.id,
    label: overrides.label || base.label,
    shortLabel: overrides.shortLabel || base.shortLabel,
    color: overrides.color || base.color,
    order: typeof overrides.order === 'number' ? overrides.order : base.order,
  }
}

const sameWindow = (a, b) =>
  a.resetsAt !== undefined && b.resetsAt !== undefined && Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) < 60 * 1000

function mergeLimitList(existing, incoming, incomingNewer) {
  const out = existing.map(old => {
    const fresh = incoming.find(l => l.kind === old.kind)
    if (!fresh) return old
    if (sameWindow(old, fresh)) return fresh.percentUsed >= old.percentUsed ? fresh : old
    return incomingNewer ? fresh : old
  })
  for (const fresh of incoming) {
    if (!out.some(l => l.kind === fresh.kind)) out.push(fresh)
  }
  const order = { five_hour: 0, seven_day: 1, quota: 2 }
  out.sort((a, b) => (order[a.kind] ?? 5) - (order[b.kind] ?? 5))
  return out
}

function normalizeLimit(entry, fallbackName = '', now = Date.now()) {
  const percentUsed = extractPercentUsed(entry)
  if (percentUsed === null) return null
  const kind = inferWindowKind(fallbackName, entry.kind || entry.window)
  let resetsAt = normalizeIso(entry.resetsAt || entry.resetTime || entry.resets_at || entry.reset_at)
  if (!resetsAt && typeof entry.timeUntilResetMs === 'number' && entry.timeUntilResetMs > 0) {
    resetsAt = new Date(now + entry.timeUntilResetMs).toISOString()
  }
  const label = entry.label && !classifyModel(entry.label) ? entry.label : WINDOW_LABELS[kind] || kind
  return { kind, label, percentUsed, ...(resetsAt ? { resetsAt } : {}) }
}

function addLimitToGroup(map, id, limit, metaOverrides = {}, modelTag = null) {
  let group = map.get(id)
  if (!group) {
    group = { ...groupMetaFor(id, metaOverrides), models: [], limits: [] }
    map.set(id, group)
  }
  if (modelTag && !group.models.includes(modelTag)) group.models.push(modelTag)
  const existingIdx = group.limits.findIndex(l => l.kind === limit.kind)
  if (existingIdx < 0) {
    group.limits.push(limit)
  } else {
    const old = group.limits[existingIdx]
    // Within a pooled bucket (multiple models sharing one quota), keep the higher usage (tighter limit).
    if (limit.percentUsed > old.percentUsed || (!old.resetsAt && limit.resetsAt)) {
      group.limits[existingIdx] = limit
    }
  }
}

// Parses any supported Antigravity usage payload:
// 1. Standard Whale multi-group schema: { updatedAt, activeModel?, groups: [{ id, label?, limits: [...] }] }
// 2. antigravity-usage CLI schema: { timestamp?, quotas: [{ model, remainingFraction, resetTime }] }
//    (also accepts `models`, `buckets`, or top-level array of quota items)
// 3. Flat limits schema: { updatedAt, limits: [{ kind, percentUsed, resetsAt }] }
function normalizeUsage(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null

  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : raw.timestamp && !Number.isNaN(Date.parse(raw.timestamp))
        ? Date.parse(raw.timestamp)
        : now

  const activeModel = typeof raw.activeModel === 'string' && raw.activeModel.trim() ? raw.activeModel.trim() : null
  const groupMap = new Map()

  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      if (!g || typeof g !== 'object') continue
      const id = g.id ? String(g.id) : classifyBucket(g.family || g.label || g.name || '')
      const rawLimits = Array.isArray(g.limits) ? g.limits : [g]
      for (const item of rawLimits) {
        const limit = normalizeLimit(item, g.id || g.label || '')
        if (!limit) continue
        addLimitToGroup(
          groupMap,
          id,
          limit,
          { label: g.label, shortLabel: g.shortLabel, color: g.color, order: g.order },
          g.model || null,
        )
      }
      if (Array.isArray(g.models) && groupMap.has(id)) {
        const entry = groupMap.get(id)
        for (const m of g.models) {
          if (typeof m === 'string' && !entry.models.includes(m)) entry.models.push(m)
        }
      }
    }
  } else {
    const items = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.quotas)
        ? raw.quotas
        : Array.isArray(raw.models)
          ? raw.models
          : Array.isArray(raw.buckets)
            ? raw.buckets
            : null

    if (items) {
      const nonAuto = items.filter(it => it && !it.isAutocompleteOnly)
      const list = nonAuto.length > 0 ? nonAuto : items
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const modelField = item.model || item.modelId || item.label || item.name || item.id || item.bucket || ''
        const id = item.group ? String(item.group) : classifyBucket(String(modelField))
        const limit = normalizeLimit(item, String(modelField), now)
        if (!limit) continue
        addLimitToGroup(groupMap, id, limit, { label: item.groupLabel }, modelField ? String(modelField) : null)
        if (item.label && groupMap.has(id)) {
          const entry = groupMap.get(id)
          if (!entry.models.includes(String(item.label))) entry.models.push(String(item.label))
        }
      }
    } else if (Array.isArray(raw.limits)) {
      for (const item of raw.limits) {
        const limit = normalizeLimit(item, '', now)
        if (!limit) continue
        const id = item.group ? String(item.group) : 'gemini'
        addLimitToGroup(groupMap, id, limit)
      }
    }
  }

  const groups = [...groupMap.values()]
  if (groups.length === 0) return null
  for (const g of groups) {
    g.limits.sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : a.kind.localeCompare(b.kind)))
  }
  groups.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return { updatedAt, activeModel, groups }
}

// Merges file-based usage with external CLI usage (higher value wins inside the same window).
function mergeUsage(fileUsage, cliUsage) {
  if (!cliUsage || !Array.isArray(cliUsage.groups) || cliUsage.groups.length === 0) return fileUsage
  if (!fileUsage || !Array.isArray(fileUsage.groups) || fileUsage.groups.length === 0) return cliUsage
  const cliNewer = (cliUsage.updatedAt ?? 0) >= (fileUsage.updatedAt ?? 0)
  const map = new Map()
  for (const g of fileUsage.groups) {
    map.set(g.id, { ...g, models: [...(g.models || [])], limits: [...g.limits] })
  }
  for (const g of cliUsage.groups) {
    const old = map.get(g.id)
    if (!old) {
      map.set(g.id, { ...g, models: [...(g.models || [])], limits: [...g.limits] })
    } else {
      old.limits = mergeLimitList(old.limits, g.limits, cliNewer)
      for (const m of g.models || []) if (!old.models.includes(m)) old.models.push(m)
    }
  }
  const groups = [...map.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return {
    updatedAt: Math.max(fileUsage.updatedAt ?? 0, cliUsage.updatedAt ?? 0),
    activeModel: (cliNewer ? cliUsage.activeModel : fileUsage.activeModel) ?? fileUsage.activeModel ?? cliUsage.activeModel ?? null,
    groups,
  }
}

// Picks which quota group corresponds to the currently selected model in Antigravity.
function resolveActiveGroup(groups, activeModel, overrideGroup = 'auto') {
  if (!Array.isArray(groups) || groups.length === 0) return null
  if (overrideGroup && overrideGroup !== 'auto') {
    const manual = groups.find(g => g.id === overrideGroup)
    if (manual) return manual
  }
  if (activeModel) {
    const needle = activeModel.trim().toLowerCase()
    const direct = groups.find(
      g =>
        g.id.toLowerCase() === needle ||
        g.label.toLowerCase() === needle ||
        (g.models || []).some(m => m.toLowerCase() === needle),
    )
    if (direct) return direct

    const family = classifyModel(activeModel)
    const fallbackChain = {
      gemini_pro: ['gemini_pro', 'gemini', 'gemini_flash'],
      gemini_flash: ['gemini_flash', 'gemini', 'gemini_pro'],
      gemini: ['gemini', 'gemini_pro', 'gemini_flash'],
      claude: ['claude', 'third_party'],
      gpt: ['gpt', 'third_party', 'claude'],
      third_party: ['third_party', 'claude', 'gpt'],
    }[family] || []

    for (const candidateId of fallbackChain) {
      const hit = groups.find(g => g.id === candidateId)
      if (hit) return hit
    }
  }
  return groups[0]
}

// Reads the state file written by the Antigravity hooks plugin.
function readState(file = statePath()) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      modelName: typeof parsed.modelName === 'string' && parsed.modelName.trim() ? parsed.modelName.trim() : null,
      conversationId: parsed.conversationId || null,
    }
  } catch {
    return null
  }
}

function readUsageFile(file = usagePath()) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return normalizeUsage(JSON.parse(text))
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('could not read antigravity usage file', err.message)
    return null
  }
}

// Builds the normalized payload sent to the renderer for Antigravity mode.
function buildRendererPayload({ usage, activeModel, overrideGroup = 'auto', quotaStatus = 'empty', quotaError = null }) {
  const groups = usage?.groups || []
  const chosen = resolveActiveGroup(groups, activeModel || usage?.activeModel || null, overrideGroup)
  const orderedGroups = chosen
    ? [chosen, ...groups.filter(g => g.id !== chosen.id)].map(g => ({ ...g, active: g.id === chosen.id }))
    : []
  const limits = chosen
    ? chosen.limits.map(l => ({ ...l, groupId: chosen.id, groupLabel: chosen.label, shortLabel: chosen.shortLabel, color: chosen.color }))
    : []
  return {
    host: 'antigravity',
    hostLabel: 'Antigravity',
    updatedAt: usage?.updatedAt || null,
    activeModel: activeModel || usage?.activeModel || null,
    activeGroup: chosen?.id || null,
    activeGroupLabel: chosen?.label || null,
    overrideGroup,
    quotaStatus: groups.length > 0 ? 'ok' : quotaStatus,
    quotaError,
    limits,
    groups: orderedGroups,
  }
}

// Extracts the first JSON value from stdout (tolerates leading warnings/ANSI codes from CLIs).
function parseJsonStdout(stdout) {
  const clean = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (!clean) return null
  try {
    return JSON.parse(clean)
  } catch {
    const startObj = clean.indexOf('{')
    const startArr = clean.indexOf('[')
    const start = startObj >= 0 && startArr >= 0 ? Math.min(startObj, startArr) : Math.max(startObj, startArr)
    if (start < 0) return null
    return JSON.parse(clean.slice(start))
  }
}

function isCommandNotFound(err, stderr) {
  const msg = `${err?.message || ''} ${stderr || ''}`.toLowerCase()
  return (
    err?.code === 'ENOENT' ||
    err?.code === 9009 ||
    msg.includes('is not recognized') ||
    msg.includes('not found') ||
    msg.includes('无法将') ||
    msg.includes('不是内部或外部命令')
  )
}

// Polls an optional external quota CLI (default `antigravity-usage quota --json`).
let command = DEFAULT_COMMAND
let intervalMs = DEFAULT_INTERVAL_SEC * 1000
let enabled = true
let status = 'idle' // 'idle' | 'ok' | 'missing-cli' | 'error' | 'disabled'
let lastError = null
let latestCli = null
let timer = null
let running = false
let lastRunAt = 0
let onChange = () => {}

function scheduleNext(delay) {
  clearTimeout(timer)
  if (!enabled || !command) return
  timer = setTimeout(() => runOnce(), delay)
}

// Finds globally installed antigravity-usage's JS entry point so Electron can run it directly
// with its bundled Node 24 runtime (even if the system PATH has an older Node or restricted .ps1).
function findAntigravityUsageEntry() {
  const candidates = []
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'antigravity-usage', 'dist', 'index.js'))
  }
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'antigravity-usage', 'dist', 'index.js'))
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file
    } catch {
      // ignore
    }
  }
  return null
}

function splitCommandArgs(cmd) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(cmd)) !== null) tokens.push(m[1] ?? m[2] ?? m[3])
  return tokens
}

function executeQuotaCommand(cmd, callback) {
  const tokens = splitCommandArgs(cmd)
  if (tokens.length > 0 && /^antigravity-usage(?:\.cmd|\.exe)?$/i.test(tokens[0])) {
    const entry = findAntigravityUsageEntry()
    if (entry && process.versions.electron) {
      execFile(
        process.execPath,
        [entry, ...tokens.slice(1)],
        {
          windowsHide: true,
          timeout: CMD_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
        callback,
      )
      return
    }
  }
  exec(cmd, { windowsHide: true, timeout: CMD_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, callback)
}

function runOnce({ force = false } = {}) {
  if (!enabled || !command) {
    status = 'disabled'
    return
  }
  const now = Date.now()
  if (running) return
  if (!force && now - lastRunAt < REFRESH_COOLDOWN_MS) return
  running = true
  lastRunAt = now
  clearTimeout(timer)

  executeQuotaCommand(command, (err, stdout, stderr) => {
    running = false
    if (err) {
      if (isCommandNotFound(err, stderr)) {
        if (status !== 'missing-cli') log.info('antigravity quota command not found:', command)
        status = 'missing-cli'
        lastError = `未检测到命令：${command}`
        onChange()
        scheduleNext(MISSING_RETRY_MS)
        return
      }
      const message = (stderr || err.message || 'unknown error').trim().slice(0, 180)
      if (message !== lastError) log.warn('antigravity quota command failed:', message)
      status = 'error'
      lastError = message
      onChange()
      scheduleNext(ERROR_RETRY_MS)
      return
    }

    try {
      const parsed = parseJsonStdout(stdout)
      const normalized = normalizeUsage(parsed, Date.now())
      if (!normalized) throw new Error('命令输出里没有可识别的额度字段')
      latestCli = normalized
      status = 'ok'
      lastError = null
      onChange()
      scheduleNext(intervalMs)
    } catch (parseErr) {
      const message = parseErr.message || 'JSON 解析失败'
      if (message !== lastError) log.warn('antigravity quota output unreadable:', message)
      status = 'error'
      lastError = message
      onChange()
      scheduleNext(ERROR_RETRY_MS)
    }
  })
}

function start(changed, options = {}) {
  onChange = changed || (() => {})
  configure(options, { runImmediately: true })
}

function configure({ cmd, intervalSec, isEnabled } = {}, { runImmediately = false } = {}) {
  if (typeof cmd === 'string') command = cmd.trim()
  if (typeof intervalSec === 'number' && intervalSec >= 10) intervalMs = intervalSec * 1000
  if (typeof isEnabled === 'boolean') enabled = isEnabled
  clearTimeout(timer)
  if (!enabled || !command) {
    status = 'disabled'
    latestCli = null
    lastError = null
    onChange()
    return
  }
  if (runImmediately) runOnce({ force: true })
  else scheduleNext(intervalMs)
}

function stop() {
  clearTimeout(timer)
  timer = null
}

module.exports = {
  DEFAULT_COMMAND,
  DEFAULT_INTERVAL_SEC,
  GROUP_META,
  whaleDir,
  usagePath,
  statePath,
  sessionsDir,
  classifyModel,
  classifyBucket,
  normalizeUsage,
  mergeUsage,
  resolveActiveGroup,
  readState,
  readUsageFile,
  buildRendererPayload,
  parseJsonStdout,
  start,
  configure,
  stop,
  refreshNow: () => runOnce({ force: true }),
  state: () => ({ status, error: lastError, command, enabled }),
  latest: () => latestCli,
}
