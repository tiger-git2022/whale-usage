// Antigravity quota protocol, model-to-group mapping, native local reading, and optional CLI polling.
//
// Reads three local sources and merges them into a unified multi-group usage object (all percents are
// normalized to percentUsed 0..100 so alerts and colors match the Claude widget):
//   1. Antigravity 2.0's language_server.exe RPC (RetrieveUserQuotaSummary / GetUserStatus), read
//      directly from localhost. This is the authoritative source for the weekly + 5-hour pools.
//   2. ~/.gemini/antigravity/whale/usage.json   standard multi-group usage file (or custom script output)
//   3. External quota command (default: `antigravity-usage quota --json`) as a fallback
//
// Current model detection combines:
//   - UI Automation text near Antigravity's input box (instant, even before sending a message)
//   - ~/.gemini/antigravity/whale/state.json written by the official Antigravity hooks plugin

const { exec, execFile, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')
const log = require('./log')

const DEFAULT_COMMAND = 'antigravity-usage quota --json --refresh'
const DEFAULT_INTERVAL_SEC = 60
const ERROR_RETRY_MS = 2 * 60 * 1000
const CMD_TIMEOUT_MS = 15 * 1000
const REFRESH_COOLDOWN_MS = 5 * 1000
const LOCAL_DISCOVERY_TIMEOUT_MS = 8 * 1000
const LOCAL_RPC_TIMEOUT_MS = 1500
const QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus'

const GROUP_META = {
  gemini: { id: 'gemini', label: 'Gemini 模型', shortLabel: 'Gem', color: 'gemini', order: 0 },
  gemini_argon: { id: 'gemini_argon', label: 'Gemini 4 Argon', shortLabel: 'Argon', color: 'flash', order: 1 },
  gemini_pro: { id: 'gemini_pro', label: 'Gemini Pro', shortLabel: 'Pro', color: 'gemini', order: 0 },
  gemini_flash: { id: 'gemini_flash', label: 'Gemini Flash', shortLabel: 'Flash', color: 'flash', order: 1 },
  claude: { id: 'claude', label: 'Claude 模型', shortLabel: 'Cla', color: 'claude', order: 2 },
  third_party: { id: 'claude', label: 'Claude 模型', shortLabel: 'Cla', color: 'claude', order: 2 },
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
// In Antigravity 2.0, Claude and GPT share the "Claude 与 GPT 模型" pool (mapped to 'claude'),
// Gemini 4 Argon has its own 'gemini_argon' pool, and other Gemini 4 / 3.8 models share 'gemini'.
function classifyModel(name) {
  if (!name || typeof name !== 'string') return null
  const text = name.trim().toLowerCase()
  if (!text || text === 'auto' || text === 'default') return null

  if (/\bargon\b/.test(text) || text.includes('argon')) return 'gemini_argon'
  if (/\b(claude|sonnet|opus|haiku|anthropic|gpt|openai|o1|o3|o4|codex|3p|third[_\-\s]?party)\b/.test(text) || text.includes('claude') || text.includes('gpt')) {
    return 'claude'
  }
  if (text.includes('gemini') || /\b(neon|hydrogen|carbon|orchestrator)\b/.test(text)) {
    if (/gemini[_\-\s]?(2\.5|3|3\.5)[_\-\s]?flash|\bflash[_\-\s]?lite\b|^gemini[_\-]flash\b/.test(text)) return 'gemini_flash'
    if (/gemini[_\-\s]?(2\.5|3)[_\-\s]?pro|^gemini[_\-]pro\b/.test(text)) return 'gemini_pro'
    return 'gemini'
  }
  if (/\b(flash|lite)\b/.test(text)) return 'gemini_flash'
  return null
}

// Classifies a quota bucket identifier from CLI/JSON output.
function classifyBucket(name) {
  if (!name || typeof name !== 'string') return 'other'
  const text = name.trim().toLowerCase()
  if (text === 'gpt' || text === 'third_party' || /^3p\b/.test(text)) return 'claude'
  if (GROUP_META[text]) return GROUP_META[text].id
  if (/^gemini([_\-\s]?(5h|7d|daily|weekly|quota|all|pool|模型|models?))?$/.test(text)) return 'gemini'
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
      const rawId = g.id ? String(g.id) : classifyBucket(g.family || g.label || g.name || '')
      const id = rawId === 'gpt' || rawId === 'third_party' ? 'claude' : rawId
      const rawLimits = Array.isArray(g.limits) ? g.limits : [g]
      for (const item of rawLimits) {
        const limit = normalizeLimit(item, g.id || g.label || '', now)
        if (!limit) continue
        addLimitToGroup(
          groupMap,
          id,
          limit,
          { label: id === 'claude' && /gpt/i.test(g.label || '') ? 'Claude 模型' : g.label, shortLabel: g.shortLabel, color: g.color, order: g.order },
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
    // Ignore antigravity-usage's unlinked free-tier Google CloudCode fallback when it reports 100%
    // remaining (0% used) across the board with no real usage figures.
    if (
      raw.method === 'google' &&
      Array.isArray(raw.models) &&
      raw.models.length > 0 &&
      raw.models.every(m => m && (m.remainingPercentage === 1 || m.isAutocompleteOnly))
    ) {
      return null
    }
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
      gemini_argon: ['gemini_argon', 'gemini', 'gemini_pro', 'gemini_flash'],
      gemini: ['gemini', 'gemini_pro', 'gemini_flash', 'gemini_argon'],
      gemini_pro: ['gemini_pro', 'gemini', 'gemini_flash', 'gemini_argon'],
      gemini_flash: ['gemini_flash', 'gemini', 'gemini_pro'],
      claude: ['claude', 'third_party'],
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

function saveUsageFile(usage, file = usagePath()) {
  if (!usage || !Array.isArray(usage.groups) || usage.groups.length === 0) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(usage, null, 2))
  } catch (err) {
    log.warn('could not save antigravity usage file', err.message)
  }
}

function parseRelativeResetIso(text, now = Date.now()) {
  if (typeof text !== 'string') return undefined
  const en = text.match(/resets?\s+in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i)
  if (en && (en[1] || en[2] || en[3])) {
    const d = Number(en[1] || 0)
    const h = Number(en[2] || 0)
    const m = Number(en[3] || 0)
    const ms = ((d * 24 + h) * 60 + m) * 60 * 1000
    if (ms > 0) return new Date(now + ms).toISOString()
  }
  const zh = text.match(/(?:(\d+)\s*天)?\s*(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分(?:钟)?)?\s*(?:后)?重置/)
  if (zh && (zh[1] || zh[2] || zh[3])) {
    const d = Number(zh[1] || 0)
    const h = Number(zh[2] || 0)
    const m = Number(zh[3] || 0)
    const ms = ((d * 24 + h) * 60 + m) * 60 * 1000
    if (ms > 0) return new Date(now + ms).toISOString()
  }
  return undefined
}

// Parses text nodes collected from Antigravity 2.0's "使用情况 / Usage" popup via UI Automation.
function parseUsagePanelTexts(texts, now = Date.now()) {
  if (!Array.isArray(texts) || texts.length === 0) return null
  const groupMap = new Map()
  let currentGroupId = null
  let currentGroupLabel = null
  let pendingKind = null
  let lastLimit = null

  const ensureGroup = (id, label) => {
    currentGroupId = id
    currentGroupLabel = label
    pendingKind = null
    lastLimit = null
  }

  for (const raw of texts) {
    const line = String(raw || '').trim()
    if (!line || /^(使用情况|usage|查看用量|view usage)$/i.test(line)) continue

    // Check if the line names a group header
    if (/^gemini\s*(模型|models?)$/i.test(line)) {
      ensureGroup('gemini', 'Gemini 模型')
      continue
    }
    if (/^claude(\s*(与|&|and)\s*gpt)?\s*(模型|models?)?$/i.test(line)) {
      ensureGroup('claude', 'Claude 模型')
      continue
    }
    if (/^gemini\s+4\s+argon/i.test(line) && !/%/.test(line)) {
      ensureGroup('gemini_argon', 'Gemini 4 Argon')
      continue
    }

    // Window label inside a group
    if (/^(每周限额|weekly\s+limit)$/i.test(line)) {
      pendingKind = 'seven_day'
      continue
    }
    if (/^(5h\s+limit|5\s*小时限额|5\s*小时)$/i.test(line)) {
      pendingKind = 'five_hour'
      continue
    }

    // Combined group header + percentage on one line, e.g. "Gemini 4 Argon 71% 剩余"
    const headPct = line.match(/^(gemini[\w\s.\-()]+|claude[\w\s.\-()]+?)\s+(\d+(?:\.\d+)?)\s*%\s*(剩余|remaining|left|已用|used)/i)
    if (headPct) {
      const gTitle = headPct[1].trim()
      const gId = classifyBucket(gTitle)
      ensureGroup(gId, gId === 'claude' ? 'Claude 模型' : gTitle)
    }

    // Percentage reading: "70% 剩余" -> 30% used
    const remMatch = line.match(/(\d+(?:\.\d+)?)\s*%\s*(?:剩余|remaining|left)/i)
    const usedMatch = !remMatch && line.match(/(\d+(?:\.\d+)?)\s*%\s*(?:已用|used)/i)
    if ((remMatch || usedMatch) && currentGroupId) {
      const pct = remMatch ? clampPercent(100 - Number(remMatch[1])) : clampPercent(Number(usedMatch[1]))
      const kind =
        /weekly|每周/i.test(line) ? 'seven_day'
        : /5h|5\s*小时/i.test(line) ? 'five_hour'
        : pendingKind || (currentGroupId === 'gemini_argon' ? 'seven_day' : 'five_hour')
      const resetsAt = parseRelativeResetIso(line, now)
      const limit = {
        kind,
        label: WINDOW_LABELS[kind] || kind,
        percentUsed: pct,
        ...(resetsAt ? { resetsAt } : {}),
      }
      addLimitToGroup(groupMap, currentGroupId, limit, { label: currentGroupLabel })
      const grp = groupMap.get(currentGroupId)
      lastLimit = grp.limits.find(l => l.kind === kind) || limit
      pendingKind = null
      continue
    }

    // Reset line (may also clarify whether the previous single-row reading was Weekly or 5h)
    const resetsAt = parseRelativeResetIso(line, now)
    if (resetsAt && lastLimit && currentGroupId) {
      if (/weekly|每周/i.test(line) && lastLimit.kind !== 'seven_day') {
        lastLimit.kind = 'seven_day'
        lastLimit.label = WINDOW_LABELS.seven_day
      } else if (/5h|5\s*小时/i.test(line) && lastLimit.kind !== 'five_hour') {
        lastLimit.kind = 'five_hour'
        lastLimit.label = WINDOW_LABELS.five_hour
      }
      lastLimit.resetsAt = resetsAt
    }
  }

  const groups = [...groupMap.values()]
  if (groups.length === 0) return null
  for (const g of groups) {
    g.limits.sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : a.kind.localeCompare(b.kind)))
  }
  groups.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return { updatedAt: now, activeModel: null, groups }
}

// --- Native Antigravity 2.0 language_server RPC ---------------------------
//
// Antigravity 2.0 starts language_server.exe with several listening ports. Most of them answer 401
// (or reject plain HTTP on the TLS port), and only one exposes the real quota RPC. We therefore probe
// every port with both protocols, accept only HTTP 200 responses, and validate the JSON body. The
// 2.0-only RetrieveUserQuotaSummary RPC returns the weekly + 5-hour buckets; GetUserStatus is kept as
// a fallback for older builds that only expose per-model remainingFraction.

function responseBody(raw) {
  if (!raw || typeof raw !== 'object') return null
  return raw.response && typeof raw.response === 'object' ? raw.response : raw
}

function parseGroupModels(description) {
  const text = String(description || '')
  const match = text.match(
    /(?:models? (?:within|in) this group|此组内(?:的)?模型|该分组包含(?:以下)?模型)\s*[:：]\s*(.+)$/i,
  )
  if (!match) return []
  return match[1]
    .split(/[,，、;；]/)
    .map(part => part.trim().replace(/[.。]$/, ''))
    .filter(Boolean)
}

function classifyQuotaSummaryGroup(displayName, description, buckets) {
  const firstBucket = Array.isArray(buckets) ? buckets.find(bucket => bucket && typeof bucket === 'object') : null
  const bucketId = firstBucket ? firstBucket.bucketId || firstBucket.bucket_id || '' : ''
  const byName = classifyModel(displayName)
  if (byName) return byName
  const byBucket = classifyModel(bucketId)
  if (byBucket) return byBucket
  if (/argon/i.test(String(description || ''))) return 'gemini_argon'
  if (/claude|gpt|3p|third[\s_-]?party/i.test(String(description || ''))) return 'claude'
  return 'gemini'
}

// Parses language_server's RetrieveUserQuotaSummary response into the standard multi-group schema.
function parseQuotaSummary(raw, now = Date.now()) {
  const body = responseBody(raw)
  if (!body || typeof body !== 'object') return null
  const rawGroups = Array.isArray(body.groups)
    ? body.groups
    : Array.isArray(body.quotaGroups)
      ? body.quotaGroups
      : null
  if (!rawGroups || rawGroups.length === 0) return null

  const groupMap = new Map()
  for (const group of rawGroups) {
    if (!group || typeof group !== 'object') continue
    const displayName = String(group.displayName || group.display_name || '')
    const description = String(group.description || '')
    const buckets = Array.isArray(group.buckets)
      ? group.buckets
      : Array.isArray(group.limits)
        ? group.limits
        : []
    const id = classifyQuotaSummaryGroup(displayName, description, buckets)
    let added = false
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue
      if (bucket.disabled === true || bucket.disabled === 'true') continue
      const percentUsed = extractPercentUsed(bucket)
      if (percentUsed === null) continue
      const kind = inferWindowKind(
        String(bucket.window || bucket.bucketId || bucket.bucket_id || bucket.displayName || bucket.display_name || ''),
      )
      const resetsAt = normalizeIso(
        bucket.resetTime || bucket.reset_time || bucket.resetsAt || bucket.resets_at,
      )
      addLimitToGroup(
        groupMap,
        id,
        { kind, label: WINDOW_LABELS[kind] || kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) },
        { label: GROUP_META[id]?.label },
      )
      added = true
    }
    if (!added) continue
    const entry = groupMap.get(id)
    for (const model of parseGroupModels(description)) {
      if (!entry.models.includes(model)) entry.models.push(model)
    }
  }

  const groups = [...groupMap.values()]
  if (groups.length === 0) return null
  for (const group of groups) {
    group.limits.sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : a.kind.localeCompare(b.kind)))
  }
  groups.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return { updatedAt: now, activeModel: null, groups }
}

// Fallback for language_server builds without RetrieveUserQuotaSummary: GetUserStatus exposes each
// model's remainingFraction under cascadeModelConfigData.clientModelConfigs.
function parseUserStatus(raw, now = Date.now()) {
  const body = responseBody(raw)
  if (!body || typeof body !== 'object') return null
  const status = body.userStatus || body.user_status || body
  const cascade = status.cascadeModelConfigData || status.cascade_model_config_data
  const configs = cascade?.clientModelConfigs || cascade?.client_model_configs
  if (!Array.isArray(configs) || configs.length === 0) return null

  const models = []
  for (const config of configs) {
    if (!config || typeof config !== 'object') continue
    const quota = config.quotaInfo || config.quota_info
    if (!quota || typeof quota !== 'object') continue
    const remaining = quota.remainingFraction ?? quota.remaining_fraction
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
    const label = String(config.label || config.displayName || config.display_name || config.modelId || config.model_id || '')
    if (!label || /autocomplete/i.test(label)) continue
    models.push({
      label,
      modelId: config.modelId || config.model_id,
      remainingPercentage: remaining,
      resetTime: quota.resetTime || quota.reset_time,
    })
  }
  if (models.length === 0) return null
  return normalizeUsage({ timestamp: new Date(now).toISOString(), method: 'local', models }, now)
}

function parseLanguageServerProcesses(stdout) {
  const text = String(stdout || '').replace(/^\uFEFF/, '').trim()
  if (!text) return []
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  const servers = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const pid = Number(item.pid ?? item.processId)
    const token = String(item.token ?? item.csrfToken ?? '').replace(/^['"]|['"]$/g, '')
    const ports = Array.isArray(item.ports)
      ? [...new Set(item.ports.map(Number).filter(port => Number.isInteger(port) && port > 0 && port < 65536))]
      : []
    if (!Number.isInteger(pid) || pid <= 0 || !token) continue
    servers.push({ pid, token, ports })
  }
  return servers
}

const DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$items = @()',
  "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | ForEach-Object {",
  '  $proc = $_',
  '  $cmd = [string]$proc.CommandLine',
  "  if ($cmd -match 'antigravity') {",
  "    $token = ''",
  "    if ($cmd -match '--csrf_token(?:=|\\s+)([^\\s]+)') { $token = $Matches[1] }",
  '    if ($token) {',
  '      $ports = @()',
  '      try { $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $proc.ProcessId -ErrorAction Stop | Select-Object -ExpandProperty LocalPort) } catch { $ports = @() }',
  '      if ($ports.Count -eq 0) {',
  "        $ports = @(netstat -ano -p tcp | Select-String -Pattern 'LISTENING' | ForEach-Object { $parts = @(($_.Line -split '\\s+') | Where-Object { $_ }); if ($parts.Count -ge 5 -and $parts[-1] -eq [string]$proc.ProcessId) { [int](($parts[1] -split ':')[-1]) } })",
  '      }',
  '      $items += [pscustomobject]@{ pid = [int]$proc.ProcessId; token = $token; ports = @($ports | Sort-Object -Unique) }',
  '    }',
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($items) -Compress -Depth 4',
].join('; ')

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: LOCAL_DISCOVERY_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (stderr && !err.stderr) err.stderr = stderr
          reject(err)
        } else {
          resolve(stdout)
        }
      },
    )
  })
}

function discoverLanguageServers() {
  if (process.platform !== 'win32') return Promise.resolve([])
  return runPowerShell(DISCOVERY_SCRIPT).then(parseLanguageServerProcesses)
}

function requestLocalJson({ port, protocol, token, rpcPath, body = '{}' }) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const transport = protocol === 'https' ? https : http
    let req
    try {
      req = transport.request(
        {
          host: '127.0.0.1',
          port,
          path: rpcPath,
          method: 'POST',
          rejectUnauthorized: false,
          timeout: LOCAL_RPC_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': token,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        res => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', chunk => {
            text += chunk
            if (text.length > 1024 * 1024) {
              req.destroy()
              finish(null)
            }
          })
          res.on('end', () => {
            if (res.statusCode !== 200) return finish(null)
            try {
              finish(JSON.parse(text))
            } catch {
              finish(null)
            }
          })
          res.on('aborted', () => finish(null))
          res.on('error', () => finish(null))
        },
      )
    } catch {
      finish(null)
      return
    }
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
    req.on('error', () => finish(null))
    req.end(body)
  })
}

function localCandidates(servers) {
  const candidates = []
  for (const server of servers) {
    for (const port of server.ports || []) {
      for (const protocol of ['https', 'http']) {
        candidates.push({ port, protocol, token: server.token })
      }
    }
  }
  return candidates
}

async function fetchQuotaSummary(servers, now) {
  const candidates = localCandidates(servers)
  const results = await Promise.all(
    candidates.map(async candidate => {
      const json = await requestLocalJson({ ...candidate, rpcPath: QUOTA_SUMMARY_PATH })
      const usage = json ? parseQuotaSummary(json, now) : null
      return usage ? { usage, endpoint: `${candidate.protocol}://127.0.0.1:${candidate.port}` } : null
    }),
  )
  return results.find(Boolean) || null
}

async function fetchUserStatus(servers, now) {
  const candidates = localCandidates(servers)
  const results = await Promise.all(
    candidates.map(async candidate => {
      const json = await requestLocalJson({ ...candidate, rpcPath: USER_STATUS_PATH })
      const usage = json ? parseUserStatus(json, now) : null
      return usage ? { usage, endpoint: `${candidate.protocol}://127.0.0.1:${candidate.port}` } : null
    }),
  )
  return results.find(Boolean) || null
}

// Reads Antigravity 2.0's own quota RPC from localhost. Returns { ok, usage?, endpoint?, code?, error? }.
async function readLocalQuota({ now = Date.now() } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'unsupported', error: '当前系统暂不支持直接读取反重力本地额度' }
  }
  let servers
  try {
    servers = await discoverLanguageServers()
  } catch (err) {
    return { ok: false, code: 'discovery-failed', error: err.message || '无法读取反重力进程' }
  }
  if (servers.length === 0) {
    return { ok: false, code: 'not-running', error: '未检测到正在运行的反重力' }
  }
  const withPorts = servers.filter(server => server.ports.length > 0)
  if (withPorts.length === 0) {
    return { ok: false, code: 'no-ports', error: '反重力本地服务没有开放端口' }
  }
  const summary = await fetchQuotaSummary(withPorts, now)
  if (summary) {
    return { ok: true, usage: summary.usage, endpoint: summary.endpoint, source: 'quota-summary' }
  }
  const legacy = await fetchUserStatus(withPorts, now)
  if (legacy) {
    return { ok: true, usage: legacy.usage, endpoint: legacy.endpoint, source: 'user-status' }
  }
  return { ok: false, code: 'rpc-failed', error: '反重力本地服务没有返回额度数据（可能版本不兼容）' }
}

// Picks the most recent known Antigravity model between UI Automation (instant on model picker
// change) and the hook state file (written when a turn runs).
function pickActiveModel({ uiModel = null, uiModelAt = 0, hookModel = null, hookUpdatedAt = 0, usageModel = null } = {}) {
  const ui = typeof uiModel === 'string' && uiModel.trim() ? uiModel.trim() : null
  const hook = typeof hookModel === 'string' && hookModel.trim() ? hookModel.trim() : null
  const usage = typeof usageModel === 'string' && usageModel.trim() ? usageModel.trim() : null
  if (ui && hook) {
    const uAt = Number.isFinite(uiModelAt) ? uiModelAt : 0
    const hAt = Number.isFinite(hookUpdatedAt) ? hookUpdatedAt : 0
    return hAt > uAt ? hook : ui
  }
  return ui || hook || usage || null
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

function isLoginRequired(err, stdout, stderr) {
  const msg = `${stdout || ''} ${stderr || ''} ${err?.message || ''}`.toLowerCase()
  return (
    msg.includes('not logged in') ||
    msg.includes('antigravity-usage login') ||
    msg.includes('noauthmethodavailable') ||
    msg.includes('no accounts') ||
    msg.includes('authentication required')
  )
}

// Polls Antigravity's own local quota RPC first, then falls back to the optional external quota CLI
// (default `antigravity-usage quota --json --refresh`).
let command = DEFAULT_COMMAND
let intervalMs = DEFAULT_INTERVAL_SEC * 1000
let enabled = true
let status = 'idle' // 'idle' | 'ok' | 'not-running' | 'missing-cli' | 'needs-login' | 'logging-in' | 'error' | 'disabled'
let lastError = null
let latestQuota = null
let latestSource = null // 'native' | 'cli' | null
let nativeError = null
let timer = null
let running = false
let loggingIn = false
let lastRunAt = 0
let onChange = () => {}

function scheduleNext(delay) {
  clearTimeout(timer)
  if (!enabled) return
  timer = setTimeout(() => runOnce(), delay)
}

function finishPoll(nextStatus, error, delay) {
  running = false
  status = nextStatus
  lastError = error || null
  onChange()
  scheduleNext(delay)
}

function nativeUnavailableStatus(nativeResult) {
  if (nativeResult?.code === 'not-running') return 'not-running'
  if (nativeResult?.code === 'unsupported') return 'error'
  return 'error'
}

function settleNativeFailure(nativeResult) {
  const next = nativeUnavailableStatus(nativeResult)
  const message = nativeResult?.error || '读取反重力本地额度失败'
  if (status !== next || lastError !== message) log.warn('antigravity local quota unavailable:', message)
  finishPoll(next, message, next === 'not-running' ? intervalMs : ERROR_RETRY_MS)
}

function applyNativeResult(result) {
  if (!enabled) {
    running = false
    status = 'disabled'
    return
  }
  const changedSource = latestSource !== 'native'
  latestQuota = result.usage
  latestSource = 'native'
  nativeError = null
  if (changedSource) log.info(`antigravity local quota: ${result.endpoint} (${result.source})`)
  finishPoll('ok', null, intervalMs)
}

function fallbackToCommand(nativeResult) {
  if (!enabled) {
    running = false
    status = 'disabled'
    return
  }
  if (!command) {
    settleNativeFailure(nativeResult)
    return
  }
  // When Antigravity itself is closed, the default CLI would only query Google's old free-tier
  // endpoint and return a fake 100% snapshot, so don't spawn it every minute. A custom command may
  // still fetch quotas remotely, so it keeps running.
  if (nativeResult?.code === 'not-running' && command === DEFAULT_COMMAND) {
    settleNativeFailure(nativeResult)
    return
  }

  executeQuotaCommand(command, (err, stdout, stderr) => {
    if (!enabled) {
      running = false
      status = 'disabled'
      return
    }
    if (err) {
      if (isCommandNotFound(err, stderr)) {
        if (nativeResult?.code === 'not-running' || nativeResult?.code === 'rpc-failed' || nativeResult?.code === 'no-ports') {
          settleNativeFailure(nativeResult)
          return
        }
        if (status !== 'missing-cli') log.info('antigravity quota command not found:', command)
        finishPoll('missing-cli', `未检测到命令：${command}`, 5 * 60 * 1000)
        return
      }
      if (isLoginRequired(err, stdout, stderr) && nativeResult?.code !== 'not-running') {
        if (status !== 'needs-login') log.info('antigravity quota needs Google login (antigravity-usage login)')
        finishPoll('needs-login', '需要登录一次 Google 账号', 5 * 60 * 1000)
        return
      }
      const message = (stderr || stdout || err.message || 'unknown error').trim().slice(0, 180)
      if (nativeResult?.error) log.warn('antigravity quota command failed:', message)
      settleNativeFailure(nativeResult)
      return
    }

    try {
      const parsed = parseJsonStdout(stdout)
      const normalized = normalizeUsage(parsed, Date.now())
      if (!normalized) {
        // The CLI's cloud mode returns a hard-coded 100% remaining snapshot with no real usage.
        settleNativeFailure(nativeResult)
        return
      }
      const changedSource = latestSource !== 'cli'
      latestQuota = normalized
      latestSource = 'cli'
      if (changedSource) log.info('antigravity quota from external command:', command)
      finishPoll('ok', null, intervalMs)
    } catch (parseErr) {
      const message = parseErr.message || 'JSON 解析失败'
      if (message !== lastError) log.warn('antigravity quota output unreadable:', message)
      settleNativeFailure(nativeResult)
    }
  })
}

// Opens the browser via `antigravity-usage login --no-browser` (using Electron's bundled Node and
// shell.openExternal so it never fails under restricted PowerShell policies) and refreshes quota on success.
function login(openUrl) {
  if (loggingIn) return
  loggingIn = true
  status = 'logging-in'
  lastError = null
  onChange()
  log.info('starting antigravity-usage login')

  const entry = findAntigravityUsageEntry()
  let child
  if (entry && process.versions.electron) {
    let pre = null
    try {
      pre = electronPreload()
    } catch (err) {
      log.warn('could not write antigravity-usage preload', err.message)
    }
    const args = pre ? ['-r', pre, entry, 'login', '--no-browser'] : [entry, 'login', '--no-browser']
    child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
  } else {
    child = spawn('antigravity-usage', ['login', '--no-browser'], {
      windowsHide: true,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  let opened = false
  let outBuf = ''
  let errBuf = ''
  const killTimer = setTimeout(() => {
    try {
      child.kill()
    } catch {}
  }, 5 * 60 * 1000)

  const checkUrl = text => {
    if (opened) return
    const m = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/\S+/)
    if (m) {
      opened = true
      log.info('opening Google OAuth URL in default browser')
      if (typeof openUrl === 'function') openUrl(m[0])
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    outBuf += chunk
    checkUrl(outBuf)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    errBuf += chunk
    checkUrl(errBuf)
  })
  child.on('error', err => {
    clearTimeout(killTimer)
    loggingIn = false
    log.warn('antigravity-usage login spawn failed:', err.message)
    status = isCommandNotFound(err, errBuf) ? 'missing-cli' : 'error'
    lastError = err.message
    onChange()
  })
  child.on('close', code => {
    clearTimeout(killTimer)
    loggingIn = false
    if (code !== 0) {
      const msg = (errBuf || outBuf || `exit ${code}`).trim().slice(0, 180)
      log.warn('antigravity-usage login failed:', msg)
      status = isCommandNotFound(null, msg) ? 'missing-cli' : 'error'
      lastError = msg
      onChange()
      return
    }
    log.info('antigravity-usage login succeeded')
    status = 'idle'
    lastError = null
    onChange()
    runOnce({ force: true })
  })
}

function logout() {
  runAntigravityCli(['logout', '--all'], CMD_TIMEOUT_MS, () => {
    if (latestSource !== 'native') {
      latestQuota = null
      latestSource = null
      status = 'needs-login'
    }
    lastError = null
    log.info('signed out of antigravity-usage')
    onChange()
  })
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

// Under Electron's Node (ELECTRON_RUN_AS_NODE), commander sees process.versions.electron and treats
// the CLI as a packaged Electron app, dropping the first argument (so `login`, `--json` were ignored).
// This preload marks it as a default app, so arguments are read like plain Node.
let preloadPath = null
function electronPreload() {
  if (preloadPath && fs.existsSync(preloadPath)) return preloadPath
  const file = path.join(os.tmpdir(), 'whale-usage-ag-preload.cjs')
  fs.writeFileSync(file, 'process.defaultApp = true\n')
  preloadPath = file
  return file
}

function runAntigravityCli(args, timeoutMs, callback) {
  const entry = findAntigravityUsageEntry()
  const opts = { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }
  if (entry && process.versions.electron) {
    let pre = null
    try {
      pre = electronPreload()
    } catch (err) {
      log.warn('could not write antigravity-usage preload', err.message)
    }
    const nodeArgs = pre ? ['-r', pre, entry, ...args] : [entry, ...args]
    execFile(process.execPath, nodeArgs, { ...opts, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, callback)
    return
  }
  exec(['antigravity-usage', ...args].join(' '), opts, callback)
}

function executeQuotaCommand(cmd, callback) {
  const tokens = splitCommandArgs(cmd)
  if (tokens.length > 0 && /^antigravity-usage(?:\.cmd|\.exe)?$/i.test(tokens[0])) {
    runAntigravityCli(tokens.slice(1), CMD_TIMEOUT_MS, callback)
    return
  }
  exec(cmd, { windowsHide: true, timeout: CMD_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, callback)
}

function runOnce({ force = false } = {}) {
  if (!enabled) {
    status = 'disabled'
    return
  }
  const now = Date.now()
  if (running || loggingIn) return
  if (!force && now - lastRunAt < REFRESH_COOLDOWN_MS) return
  running = true
  lastRunAt = now
  clearTimeout(timer)

  readLocalQuota()
    .then(result => {
      if (!enabled) {
        running = false
        status = 'disabled'
        return
      }
      if (result.ok) {
        applyNativeResult(result)
        return
      }
      nativeError = result.error || null
      fallbackToCommand(result)
    })
    .catch(err => {
      const result = { ok: false, code: 'error', error: err?.message || '读取反重力本地额度失败' }
      nativeError = result.error
      fallbackToCommand(result)
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
  if (!enabled) {
    status = 'disabled'
    latestQuota = null
    latestSource = null
    nativeError = null
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
  saveUsageFile,
  parseUsagePanelTexts,
  parseRelativeResetIso,
  parseQuotaSummary,
  parseUserStatus,
  parseLanguageServerProcesses,
  readLocalQuota,
  pickActiveModel,
  buildRendererPayload,
  parseJsonStdout,
  isLoginRequired,
  start,
  configure,
  stop,
  login,
  logout,
  refreshNow: () => runOnce({ force: true }),
  state: () => ({ status, error: lastError, command, enabled, source: latestSource, nativeError }),
  latest: () => latestQuota,
}
