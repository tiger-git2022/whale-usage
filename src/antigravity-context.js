// Antigravity per-task context window tracking via local language_server RPC.
//
// Reads all trajectories from GetAllCascadeTrajectories, then queries
// GetCascadeTrajectoryGeneratorMetadata (cached by cascadeId + stepCount + lastModifiedTime,
// falling back to tail GetCascadeTrajectorySteps) to compute each task's context usage,
// active compression threshold, and token breakdown.

const TRAJECTORIES_PATH = '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories'
const GENERATOR_METADATA_PATH = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata'
const TRAJECTORY_STEPS_PATH = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps'
const USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
const AVAILABLE_MODELS_PATH = '/exa.language_server_pb.LanguageServerService/GetAvailableModels'
const LIST_CONVERSATIONS_PATH = '/product.v1.ConversationService/ListConversations'
const GET_CONVERSATION_PATH = '/product.v1.ConversationService/GetConversation'

const RPC_METADATA = { ideName: 'antigravity', extensionName: 'antigravity' }
const CONTEXT_RPC_TIMEOUT_MS = 5000
const CONTEXT_MAX_BYTES = 16 * 1024 * 1024
const MAX_TASKS = 15
const MAX_CACHE_ENTRIES = 120
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const TAIL_STEP_WINDOW = 40
const FETCH_CONCURRENCY = 4

// Platform-enforced compression/truncation limits (tokens) for known Antigravity model placeholders.
// Live values from plannerConfig.truncationThresholdTokens / contextWindowMetadata.maxContextTokens
// always take precedence when present.
const MODEL_CONTEXT_LIMITS = {
  // Gemini 4 Neon / Hydrogen / Carbon / Argon & Orchestrators (512K)
  MODEL_PLACEHOLDER_M532: 512000,
  MODEL_PLACEHOLDER_M533: 512000,
  MODEL_PLACEHOLDER_M534: 512000,
  MODEL_PLACEHOLDER_M535: 512000,
  MODEL_PLACEHOLDER_M537: 512000,
  MODEL_PLACEHOLDER_M667: 512000,
  MODEL_PLACEHOLDER_M681: 512000,
  MODEL_PLACEHOLDER_M669: 512000,
  MODEL_PLACEHOLDER_M525: 512000,
  MODEL_PLACEHOLDER_M526: 512000,
  MODEL_PLACEHOLDER_M527: 512000,
  MODEL_PLACEHOLDER_M528: 512000,
  MODEL_PLACEHOLDER_M530: 512000,
  MODEL_PLACEHOLDER_M531: 512000,
  MODEL_PLACEHOLDER_M427: 512000,
  MODEL_PLACEHOLDER_M437: 512000,
  MODEL_PLACEHOLDER_M438: 512000,
  MODEL_PLACEHOLDER_M417: 512000,
  MODEL_PLACEHOLDER_M418: 512000,
  MODEL_PLACEHOLDER_M419: 512000,
  // Gemini 3.5-3.8 Flash & Claude 5.5 (256K)
  MODEL_PLACEHOLDER_M318: 256000,
  MODEL_PLACEHOLDER_M319: 256000,
  MODEL_PLACEHOLDER_M320: 256000,
  MODEL_PLACEHOLDER_M322: 256000,
  MODEL_PLACEHOLDER_M298: 256000,
  MODEL_PLACEHOLDER_M299: 256000,
  MODEL_PLACEHOLDER_M300: 256000,
  MODEL_PLACEHOLDER_M71: 256000,
  MODEL_PLACEHOLDER_M72: 256000,
  MODEL_PLACEHOLDER_M73: 256000,
  MODEL_PLACEHOLDER_M264: 256000,
  MODEL_PLACEHOLDER_M265: 256000,
  MODEL_PLACEHOLDER_M266: 256000,
  MODEL_PLACEHOLDER_M196: 256000,
  MODEL_PLACEHOLDER_M84: 256000,
  MODEL_PLACEHOLDER_M20: 256000,
  MODEL_PLACEHOLDER_M187: 256000,
  MODEL_PLACEHOLDER_M400: 256000,
  MODEL_PLACEHOLDER_M401: 256000,
  MODEL_PLACEHOLDER_M402: 256000,
  MODEL_PLACEHOLDER_M403: 256000,
  MODEL_PLACEHOLDER_M404: 256000,
  MODEL_PLACEHOLDER_M405: 256000,
  // Claude 4.6 (160K)
  MODEL_PLACEHOLDER_M35: 160000,
  MODEL_PLACEHOLDER_M26: 160000,
  // Gemini 3.1 Pro & legacy Flash (128K)
  MODEL_PLACEHOLDER_M16: 128000,
  MODEL_PLACEHOLDER_M37: 128000,
  MODEL_PLACEHOLDER_M36: 128000,
  MODEL_PLACEHOLDER_M133: 128000,
  MODEL_PLACEHOLDER_M132: 128000,
  MODEL_PLACEHOLDER_M47: 128000,
  MODEL_PLACEHOLDER_M18: 128000,
  // GPT-OSS 120B (80K)
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 80000,
}

const STATIC_MODEL_NAMES = {
  MODEL_PLACEHOLDER_M532: 'Gemini 4 Neon (High)',
  MODEL_PLACEHOLDER_M533: 'Gemini 4 Neon (Medium)',
  MODEL_PLACEHOLDER_M534: 'Gemini 4 Neon (Low)',
  MODEL_PLACEHOLDER_M535: 'Gemini 4 Neon (Extra High)',
  MODEL_PLACEHOLDER_M537: 'Orchestrator (Neon)',
  MODEL_PLACEHOLDER_M667: 'Orchestrator (Carbon)',
  MODEL_PLACEHOLDER_M681: 'Orchestrator (Argon)',
  MODEL_PLACEHOLDER_M669: 'Gemini 4 Hydrogen (Orchestrator)',
  MODEL_PLACEHOLDER_M525: 'Gemini 4 Hydrogen (High)',
  MODEL_PLACEHOLDER_M526: 'Gemini 4 Hydrogen (Medium)',
  MODEL_PLACEHOLDER_M527: 'Gemini 4 Hydrogen (Low)',
  MODEL_PLACEHOLDER_M528: 'Gemini 4 Hydrogen (Extra High)',
  MODEL_PLACEHOLDER_M427: 'Gemini 4 Carbon (High)',
  MODEL_PLACEHOLDER_M437: 'Gemini 4 Carbon (Medium)',
  MODEL_PLACEHOLDER_M438: 'Gemini 4 Carbon (Low)',
  MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)',
  MODEL_PLACEHOLDER_M418: 'Gemini 4 Argon (Medium)',
  MODEL_PLACEHOLDER_M419: 'Gemini 4 Argon (Low)',
  MODEL_PLACEHOLDER_M318: 'Gemini 3.8 Flash (High)',
  MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash (Medium)',
  MODEL_PLACEHOLDER_M320: 'Gemini 3.8 Flash (Low)',
  MODEL_PLACEHOLDER_M400: 'Claude Opus 5.5 (Low)',
  MODEL_PLACEHOLDER_M401: 'Claude Opus 5.5 (Medium)',
  MODEL_PLACEHOLDER_M402: 'Claude Opus 5.5 (High)',
  MODEL_PLACEHOLDER_M403: 'Claude Sonnet 5.5 (Low)',
  MODEL_PLACEHOLDER_M404: 'Claude Sonnet 5.5 (Medium)',
  MODEL_PLACEHOLDER_M405: 'Claude Sonnet 5.5 (High)',
  MODEL_PLACEHOLDER_M35: 'Claude Sonnet 4.6 (Thinking)',
  MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6 (Thinking)',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT-OSS 120B (Medium)',
}

const DEFAULT_CONTEXT_LIMIT = 256000
const SUBAGENT_TYPE_RE = /(?:SUBAGENT|SUB_AGENT|CHILD|SWARM_WORKER|WORKER|DELEGATED|BACKGROUND_AGENT|HELPER)/i
const SUBAGENT_TITLE_RE = /^\[(?:subagent|sub-agent|swarm|swarm-worker|worker|delegated|helper)(?:\s*[:#/-][^\]]*)?\]\s*/i

function parseInt0(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) && n > 0 ? n : 0
  }
  return 0
}

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10
}

function isConcreteModel(value) {
  if (typeof value !== 'string') return false
  const clean = value.trim()
  if (!clean) return false
  const upper = clean.toUpperCase()
  return upper !== 'MODEL_UNSPECIFIED' && upper !== 'MODEL_PLACEHOLDER_UNSPECIFIED'
}

function inferContextLimit(model, explicitLimit = 0, modelNames = {}) {
  const direct = parseInt0(explicitLimit)
  if (direct >= 4096) return direct
  const key = typeof model === 'string' ? model.trim() : ''
  if (key && Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_LIMITS, key)) {
    return MODEL_CONTEXT_LIMITS[key]
  }
  const label = (key && modelNames[key]) || STATIC_MODEL_NAMES[key] || key
  if (label) {
    if (/gemini[\s_-]*4|neon|hydrogen|carbon|argon|orchestrator/i.test(label)) return 512000
    if (/claude[\s_-]*(?:opus|sonnet)[\s_-]*5|gemini[\s_-]*3\.[5-9][\s_-]*flash/i.test(label)) return 256000
    if (/claude[\s_-]*(?:opus|sonnet)[\s_-]*4/i.test(label)) return 160000
    if (/gemini[\s_-]*(?:2\.5|3(?:\.1)?)/i.test(label)) return 128000
    if (/gpt[\s_-]*oss/i.test(label)) return 80000
  }
  return DEFAULT_CONTEXT_LIMIT
}

function resolveModelLabel(model, modelNames = {}) {
  if (!isConcreteModel(model)) return ''
  const key = model.trim()
  if (Object.prototype.hasOwnProperty.call(modelNames, key)) return modelNames[key]
  if (Object.prototype.hasOwnProperty.call(STATIC_MODEL_NAMES, key)) return STATIC_MODEL_NAMES[key]
  return key
}

// Builds a modelId -> displayName dictionary from GetUserStatus and/or GetAvailableModels responses.
function parseModelCatalog(userStatusRaw, availableModelsRaw) {
  const names = { ...STATIC_MODEL_NAMES }

  const usBody = userStatusRaw?.response && typeof userStatusRaw.response === 'object' ? userStatusRaw.response : userStatusRaw
  const usStatus = usBody?.userStatus || usBody?.user_status || usBody
  const clientConfigs = usStatus?.cascadeModelConfigData?.clientModelConfigs || usStatus?.cascade_model_config_data?.client_model_configs
  if (Array.isArray(clientConfigs)) {
    for (const cfg of clientConfigs) {
      if (!cfg || typeof cfg !== 'object') continue
      const label = typeof cfg.label === 'string' ? cfg.label.trim() : ''
      if (!label) continue
      const modelId = cfg.modelOrAlias?.model || cfg.modelId || cfg.model_id
      if (isConcreteModel(modelId)) names[modelId.trim()] = label
    }
  }

  const amBody =
    availableModelsRaw?.response && typeof availableModelsRaw.response === 'object'
      ? availableModelsRaw.response
      : availableModelsRaw
  const amModels = amBody?.models
  if (amModels && typeof amModels === 'object' && !Array.isArray(amModels)) {
    for (const [aliasKey, entry] of Object.entries(amModels)) {
      if (!entry || typeof entry !== 'object') continue
      const label = typeof entry.displayName === 'string' ? entry.displayName.trim() : ''
      if (!label) continue
      if (isConcreteModel(aliasKey)) names[aliasKey.trim()] = label
      if (isConcreteModel(entry.model)) names[entry.model.trim()] = label
    }
  }

  return names
}

function extractWorkspaceName(data) {
  const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : []
  for (const ws of workspaces) {
    const uri = typeof ws?.workspaceFolderAbsoluteUri === 'string' ? ws.workspaceFolderAbsoluteUri.trim() : ''
    if (uri) {
      let decoded = uri.replace(/^file:\/\/(?:localhost)?\//i, '/').replace(/\\/g, '/').replace(/\/+$/, '')
      try {
        decoded = decodeURIComponent(decoded)
      } catch {
        // keep raw
      }
      const parts = decoded.split('/').filter(Boolean)
      if (parts.length > 0) return parts[parts.length - 1]
    }
    const repo = typeof ws?.repository?.computedName === 'string' ? ws.repository.computedName.trim() : ''
    if (repo) return repo
  }
  return ''
}

function isSubagentSummary(data) {
  if (!data || typeof data !== 'object') return false
  if (typeof data.parentCascadeId === 'string' && data.parentCascadeId.trim()) return true
  const meta = data.trajectoryMetadata
  if (meta && typeof meta === 'object') {
    if (meta.isSubagent === true || meta.isChild === true) return true
    if (typeof meta.parentCascadeId === 'string' && meta.parentCascadeId.trim()) return true
    if (typeof meta.parentConversationId === 'string' && meta.parentConversationId.trim()) return true
    if (typeof meta.trajectoryType === 'string' && SUBAGENT_TYPE_RE.test(meta.trajectoryType)) return true
    if (typeof meta.role === 'string' && SUBAGENT_TYPE_RE.test(meta.role)) return true
  }
  if (typeof data.trajectoryType === 'string' && SUBAGENT_TYPE_RE.test(data.trajectoryType)) return true
  const title = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (title && SUBAGENT_TITLE_RE.test(title)) return true
  return false
}

function formatTaskTitle(cascadeId, rawSummary) {
  const clean = String(rawSummary || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean || clean === cascadeId || /^untitled$/i.test(clean)) {
    return { title: `未命名任务 (${String(cascadeId).slice(0, 8)})`, isUntitled: true }
  }
  return { title: clean.length > 72 ? `${clean.slice(0, 71).trimEnd()}…` : clean, isUntitled: false }
}

// Parses GetAllCascadeTrajectories into a normalized, sorted task summary list.
function parseTrajectories(raw) {
  const body = raw?.response && typeof raw.response === 'object' ? raw.response : raw
  const summaries = body?.trajectorySummaries
  if (!summaries || typeof summaries !== 'object') return []

  const tasks = []
  for (const [cascadeId, data] of Object.entries(summaries)) {
    if (!cascadeId || !data || typeof data !== 'object') continue
    if (data.killed === true) continue

    let model = ''
    for (const latest of [data.latestTaskBoundaryStep, data.latestNotifyUserStep]) {
      const meta = latest?.step?.metadata
      if (!meta || typeof meta !== 'object') continue
      if (isConcreteModel(meta.requestedModel?.model)) model = meta.requestedModel.model.trim()
      else if (isConcreteModel(meta.generatorModel)) model = meta.generatorModel.trim()
    }

    const status = typeof data.status === 'string' ? data.status : ''
    const isRunning = /RUNNING|EXECUTING|IN_PROGRESS/i.test(status)
    const isWaiting = /WAITING/i.test(status)
    const lastModifiedTime = typeof data.lastModifiedTime === 'string' ? data.lastModifiedTime : ''
    const parsedTime = lastModifiedTime ? Date.parse(lastModifiedTime) : 0
    const lastModifiedMs = Number.isFinite(parsedTime) ? parsedTime : 0
    const stepCount = parseInt0(data.stepCount)
    const { title, isUntitled } = formatTaskTitle(cascadeId, data.summary || data.title)

    tasks.push({
      cascadeId,
      title,
      isUntitled,
      status,
      isRunning,
      isWaiting,
      isSubagent: isSubagentSummary(data),
      stepCount,
      lastModifiedTime,
      lastModifiedMs,
      model,
      workspace: extractWorkspaceName(data),
    })
  }

  tasks.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1
    if (b.lastModifiedMs !== a.lastModifiedMs) return b.lastModifiedMs - a.lastModifiedMs
    return a.cascadeId.localeCompare(b.cascadeId)
  })
  return tasks
}

// Parses a single ConversationService Conversation object into the same summary shape as parseTrajectories.
function parseConversationSummary(raw) {
  const conv = raw?.conversation && typeof raw.conversation === 'object' ? raw.conversation : raw
  if (!conv || typeof conv !== 'object') return null
  const cascadeId = typeof conv.id === 'string' ? conv.id.trim() : ''
  if (!cascadeId) return null
  if (conv.annotations?.archived === true) return null

  const rawTitle = conv.annotations?.title || conv.state?.summary || ''
  const { title, isUntitled } = formatTaskTitle(cascadeId, rawTitle)
  const status = typeof conv.state?.runState === 'string' ? conv.state.runState : ''
  const isRunning = /RUNNING|EXECUTING|IN_PROGRESS/i.test(status)
  const isWaiting = /WAITING/i.test(status)
  const lastModifiedTime =
    (typeof conv.state?.updateTime === 'string' && conv.state.updateTime) ||
    (typeof conv.metadata?.createTime === 'string' && conv.metadata.createTime) ||
    ''
  const parsedTime = lastModifiedTime ? Date.parse(lastModifiedTime) : 0
  const lastModifiedMs = Number.isFinite(parsedTime) ? parsedTime : 0
  const parentId = typeof conv.metadata?.parentConversationId === 'string' ? conv.metadata.parentConversationId.trim() : ''

  return {
    cascadeId,
    title,
    isUntitled,
    status,
    isRunning,
    isWaiting,
    isSubagent: Boolean(parentId),
    stepCount: 0,
    lastModifiedTime,
    lastModifiedMs,
    model: '',
    workspace: '',
  }
}

function parseConversationList(raw) {
  const body = raw?.response && typeof raw.response === 'object' ? raw.response : raw
  const list = Array.isArray(body?.conversations) ? body.conversations : []
  const out = []
  for (const item of list) {
    const parsed = parseConversationSummary(item)
    if (parsed) out.push(parsed)
  }
  return out
}

// Merges trajectory summaries (richer metadata for in-memory tasks) with ConversationService entries
// (which also include historical conversations not yet loaded into GetAllCascadeTrajectories).
function mergeTaskSummaries(trajectoryTasks, conversationTasks) {
  const byId = new Map()
  for (const task of trajectoryTasks || []) {
    if (task && task.cascadeId) byId.set(task.cascadeId, task)
  }
  for (const conv of conversationTasks || []) {
    if (!conv || !conv.cascadeId) continue
    const existing = byId.get(conv.cascadeId)
    if (!existing) {
      byId.set(conv.cascadeId, conv)
    } else if (existing.isUntitled && !conv.isUntitled) {
      byId.set(conv.cascadeId, { ...existing, title: conv.title, isUntitled: false })
    }
  }
  const merged = [...byId.values()]
  merged.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1
    if (b.lastModifiedMs !== a.lastModifiedMs) return b.lastModifiedMs - a.lastModifiedMs
    return a.cascadeId.localeCompare(b.cascadeId)
  })
  return merged
}

function extractUsageNumbers(usage) {
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = parseInt0(usage.inputTokens)
  const outputTokens = parseInt0(usage.outputTokens)
  const cacheReadTokens = parseInt0(usage.cacheReadTokens)
  const cacheCreationTokens = parseInt0(usage.cacheCreationTokens)
  const thinkingOutputTokens = parseInt0(usage.thinkingOutputTokens)
  const responseOutputTokens = parseInt0(usage.responseOutputTokens)
  const total = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens
  if (total <= 0) return null
  return {
    model: isConcreteModel(usage.model) ? usage.model.trim() : '',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    thinkingOutputTokens,
    responseOutputTokens,
    total,
  }
}

function extractBreakdown(cwm) {
  const groups = cwm?.tokenBreakdown?.groups
  if (!Array.isArray(groups) || groups.length === 0) return []
  return groups
    .map(g => ({
      name: typeof g?.name === 'string' ? g.name.trim() : '',
      tokens: parseInt0(g?.numTokens),
    }))
    .filter(g => g.name && g.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6)
}

// Parses GetCascadeTrajectoryGeneratorMetadata into a task's current context snapshot.
function parseGeneratorMetadataContext(raw, fallbackModel = '', modelNames = {}) {
  const body = raw?.response && typeof raw.response === 'object' ? raw.response : raw
  const list = Array.isArray(body?.generatorMetadata) ? body.generatorMetadata : []
  if (list.length === 0) return null

  let chosen = null
  let fallback = null
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i]
    if (!entry || typeof entry !== 'object') continue
    const cm = entry.chatModel && typeof entry.chatModel === 'object' ? entry.chatModel : null
    if (!cm) continue
    const usage = extractUsageNumbers(cm.usage)
    const cwm = cm.chatStartMetadata?.contextWindowMetadata
    const estimatedUsed = parseInt0(cwm?.estimatedTokensUsed)
    if (!usage && estimatedUsed <= 0) continue

    const candidate = { entry, cm, usage, cwm, estimatedUsed }
    if (!fallback) fallback = candidate
    // Prefer an entry that carries chatStartMetadata (real main turn) or a non-shadow model.
    if (cwm || (usage && !/M50$/i.test(usage.model))) {
      chosen = candidate
      break
    }
  }

  const pick = chosen || fallback
  if (!pick) return null

  const { entry, cm, usage, cwm, estimatedUsed } = pick
  const model = (usage?.model || (isConcreteModel(cm.model) ? cm.model.trim() : '') || fallbackModel || '').trim()
  const explicitLimit = parseInt0(entry.plannerConfig?.truncationThresholdTokens) || parseInt0(cwm?.maxContextTokens)
  const contextLimit = inferContextLimit(model, explicitLimit, modelNames)
  const contextUsed = usage ? usage.total : estimatedUsed
  const isEstimated = !usage && estimatedUsed > 0
  const usagePercent = contextLimit > 0 ? clampPercent((contextUsed / contextLimit) * 100) : 0

  return {
    contextUsed,
    contextLimit,
    usagePercent,
    isEstimated,
    model,
    modelLabel: resolveModelLabel(model, modelNames),
    inputTokens: usage?.inputTokens || 0,
    cacheReadTokens: usage?.cacheReadTokens || 0,
    cacheCreationTokens: usage?.cacheCreationTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    breakdown: extractBreakdown(cwm),
    source: 'gm',
  }
}

// Fallback parser for GetCascadeTrajectorySteps (tail steps) when GM is empty or unsupported.
function parseStepsContext(raw, fallbackModel = '', modelNames = {}) {
  const body = raw?.response && typeof raw.response === 'object' ? raw.response : raw
  const steps = Array.isArray(body?.steps) ? body.steps : []
  if (steps.length === 0) return null

  let latestModel = fallbackModel || ''
  let latestUsage = null
  let usageFromPlanner = false

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (!step || typeof step !== 'object') continue
    const type = String(step.type || '')
    const meta = step.metadata && typeof step.metadata === 'object' ? step.metadata : null

    if (!latestModel && type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const pc = step.userInput?.userConfig?.plannerConfig
      const req = typeof pc?.requestedModel === 'string' ? pc.requestedModel : pc?.requestedModel?.model
      const cand = pc?.planModel || pc?.modelName || req
      if (isConcreteModel(cand)) latestModel = cand.trim()
    }
    if (!latestModel && meta && type !== 'CORTEX_STEP_TYPE_CHECKPOINT') {
      const cand = meta.requestedModel?.model || meta.generatorModel
      if (isConcreteModel(cand)) latestModel = cand.trim()
    }

    if (!latestUsage && meta?.modelUsage) {
      const extracted = extractUsageNumbers(meta.modelUsage)
      if (extracted) {
        latestUsage = extracted
        usageFromPlanner = type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE'
        if (usageFromPlanner && extracted.model && !latestModel) latestModel = extracted.model
      }
    }

    if (latestUsage && latestModel) break
  }

  if (!latestUsage) return null
  const limitModel = usageFromPlanner && latestUsage.model ? latestUsage.model : latestModel || latestUsage.model
  const contextLimit = inferContextLimit(limitModel, 0, modelNames)
  const displayModel = latestModel || latestUsage.model
  return {
    contextUsed: latestUsage.total,
    contextLimit,
    usagePercent: contextLimit > 0 ? clampPercent((latestUsage.total / contextLimit) * 100) : 0,
    isEstimated: false,
    model: displayModel,
    modelLabel: resolveModelLabel(displayModel, modelNames),
    inputTokens: latestUsage.inputTokens,
    cacheReadTokens: latestUsage.cacheReadTokens,
    cacheCreationTokens: latestUsage.cacheCreationTokens,
    outputTokens: latestUsage.outputTokens,
    breakdown: [],
    source: 'steps',
  }
}

function normalizeTitleForMatch(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\u2026|\.{3})+$/, '')
    .trim()
    .toLowerCase()
}

// Matches UIA-observed window/header/selected title candidates against known tasks.
// Exact title matches win first; truncated prefix matches require at least 6 characters.
function matchTaskByTitles(tasks, titles) {
  if (!Array.isArray(tasks) || tasks.length === 0 || !Array.isArray(titles) || titles.length === 0) return null
  const normalizedCandidates = titles.map(normalizeTitleForMatch).filter(t => t.length >= 2)
  if (normalizedCandidates.length === 0) return null

  const namedTasks = tasks
    .filter(t => t && !t.isUntitled && typeof t.title === 'string')
    .map(t => ({ task: t, norm: normalizeTitleForMatch(t.title) }))
    .filter(item => item.norm.length >= 2)

  for (const cand of normalizedCandidates) {
    const exactMain = namedTasks.find(item => !item.task.isSubagent && item.norm === cand)
    if (exactMain) return exactMain.task
    const exactAny = namedTasks.find(item => item.norm === cand)
    if (exactAny) return exactAny.task
  }

  for (const cand of normalizedCandidates) {
    if (cand.length < 6) continue
    let best = null
    let bestScore = 0
    for (const item of namedTasks) {
      const shorter = Math.min(cand.length, item.norm.length)
      if (shorter < 6) continue
      if (item.norm.startsWith(cand) || cand.startsWith(item.norm)) {
        const score = shorter + (item.task.isSubagent ? 0 : 1000)
        if (score > bestScore) {
          bestScore = score
          best = item.task
        }
      }
    }
    if (best) return best
  }

  return null
}

// Selects which task should be highlighted and shown in the pet's Ctx badge.
function resolveActiveTask(
  tasks,
  { pinnedTaskId = null, uiConversationId = null, uiConversationTitles = null, hookConversationId = null } = {},
) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null
  if (pinnedTaskId) {
    const pinned = tasks.find(t => t.cascadeId === pinnedTaskId)
    if (pinned) return pinned
  }
  if (uiConversationId) {
    const focused = tasks.find(t => t.cascadeId === uiConversationId)
    if (focused) return focused
    // The user switched to a specific conversation whose context has not loaded yet; avoid showing a stale task.
    return null
  }
  if (Array.isArray(uiConversationTitles) && uiConversationTitles.length > 0) {
    const byTitle = matchTaskByTitles(tasks, uiConversationTitles)
    if (byTitle) return byTitle
  }
  if (hookConversationId) {
    const hooked = tasks.find(t => t.cascadeId === hookConversationId)
    if (hooked) return hooked
  }
  const runningMain = tasks.find(t => t.isRunning && !t.isSubagent)
  if (runningMain) return runningMain
  const latestMain = tasks.find(t => !t.isSubagent)
  if (latestMain) return latestMain
  return tasks[0]
}

// Stateful reader with per-task stepCount+mtime caching and model-name catalog caching.
function createContextReader({ discoverServers, requestJson, log } = {}) {
  const taskCache = new Map() // cascadeId -> { sig, context }
  let cachedEndpoint = null // { port, protocol, token }
  let modelNames = { ...STATIC_MODEL_NAMES }
  let modelCatalogAt = 0

  function setEndpoint(endpoint) {
    if (endpoint && endpoint.port && endpoint.protocol && endpoint.token) {
      cachedEndpoint = { port: endpoint.port, protocol: endpoint.protocol, token: endpoint.token }
    }
  }

  function clearCache() {
    taskCache.clear()
    cachedEndpoint = null
    modelCatalogAt = 0
  }

  function setCachedTask(cascadeId, entry) {
    taskCache.delete(cascadeId)
    taskCache.set(cascadeId, entry)
    while (taskCache.size > MAX_CACHE_ENTRIES) {
      taskCache.delete(taskCache.keys().next().value)
    }
  }

  async function callEndpoint(ep, rpcPath, bodyObj, options = {}) {
    return requestJson({
      port: ep.port,
      protocol: ep.protocol,
      token: ep.token,
      rpcPath,
      body: JSON.stringify(bodyObj || {}),
      timeoutMs: options.timeoutMs || CONTEXT_RPC_TIMEOUT_MS,
      maxBytes: options.maxBytes || CONTEXT_MAX_BYTES,
    })
  }

  async function refreshModelCatalog(ep, now) {
    if (now - modelCatalogAt < MODEL_CATALOG_TTL_MS && Object.keys(modelNames).length > Object.keys(STATIC_MODEL_NAMES).length) {
      return
    }
    const [us, am] = await Promise.all([
      callEndpoint(ep, USER_STATUS_PATH, { metadata: RPC_METADATA }, { timeoutMs: 2500, maxBytes: 4 * 1024 * 1024 }),
      callEndpoint(ep, AVAILABLE_MODELS_PATH, {}, { timeoutMs: 2500, maxBytes: 4 * 1024 * 1024 }),
    ])
    if (us || am) {
      modelNames = parseModelCatalog(us, am)
      modelCatalogAt = now
    }
  }

  async function probeTrajectories(preferredEndpoint) {
    const tried = new Set()
    const tryOne = async ep => {
      if (!ep || !ep.port || !ep.token) return null
      const key = `${ep.protocol}:${ep.port}:${ep.token}`
      if (tried.has(key)) return null
      tried.add(key)
      const json = await callEndpoint(
        ep,
        TRAJECTORIES_PATH,
        { metadata: RPC_METADATA },
        { timeoutMs: 2500, maxBytes: 8 * 1024 * 1024 },
      )
      const body = json?.response && typeof json.response === 'object' ? json.response : json
      if (body && typeof body.trajectorySummaries === 'object') {
        return { endpoint: ep, raw: json }
      }
      return null
    }

    for (const ep of [preferredEndpoint, cachedEndpoint]) {
      const hit = await tryOne(ep)
      if (hit) {
        cachedEndpoint = hit.endpoint
        return hit
      }
    }

    let servers = []
    try {
      servers = await discoverServers()
    } catch {
      return null
    }
    const candidates = []
    for (const server of servers) {
      if (!server?.token) continue
      for (const port of server.ports || []) {
        for (const protocol of ['https', 'http']) {
          candidates.push({ port, protocol, token: server.token })
        }
      }
    }
    const hits = await Promise.all(candidates.map(tryOne))
    const winner = hits.find(Boolean) || null
    if (winner) cachedEndpoint = winner.endpoint
    return winner
  }

  async function fetchTaskContext(ep, task) {
    const sig =
      task.stepCount > 0
        ? `${task.stepCount}:${task.lastModifiedTime}`
        : task.lastModifiedTime
          ? `conv:${task.lastModifiedTime}`
          : ''
    if (sig) {
      const cached = taskCache.get(task.cascadeId)
      if (cached && cached.sig === sig && cached.context) {
        return {
          ...cached.context,
          modelLabel: resolveModelLabel(cached.context.model, modelNames),
        }
      }
    }

    const gm = await callEndpoint(ep, GENERATOR_METADATA_PATH, {
      cascadeId: task.cascadeId,
      metadata: RPC_METADATA,
    })
    let ctx = gm ? parseGeneratorMetadataContext(gm, task.model, modelNames) : null

    if (!ctx && task.stepCount > 0) {
      const start = Math.max(0, task.stepCount - TAIL_STEP_WINDOW)
      const stepsRaw = await callEndpoint(ep, TRAJECTORY_STEPS_PATH, {
        cascadeId: task.cascadeId,
        startIndex: start,
        endIndex: task.stepCount,
        stepOffset: start,
      })
      ctx = stepsRaw ? parseStepsContext(stepsRaw, task.model, modelNames) : null
    }

    if (ctx && sig) {
      setCachedTask(task.cascadeId, { sig, context: ctx })
    }
    return ctx
  }

  async function fetchConversationTask(ep, conversationId) {
    const convRaw = await callEndpoint(
      ep,
      GET_CONVERSATION_PATH,
      { conversationId },
      { timeoutMs: 2500, maxBytes: 1024 * 1024 },
    )
    const parsed = convRaw ? parseConversationSummary(convRaw) : null
    if (parsed) return parsed
    const { title, isUntitled } = formatTaskTitle(conversationId, '')
    return {
      cascadeId: conversationId,
      title,
      isUntitled,
      status: '',
      isRunning: false,
      isWaiting: false,
      isSubagent: false,
      stepCount: 0,
      lastModifiedTime: '',
      lastModifiedMs: 0,
      model: '',
      workspace: '',
    }
  }

  async function readTasks({ preferredEndpoint = null, focusedTaskId = null, pinnedTaskId = null, now = Date.now() } = {}) {
    const probed = await probeTrajectories(preferredEndpoint)
    if (!probed) return { ok: false, tasks: [] }

    const { endpoint, raw } = probed
    await refreshModelCatalog(endpoint, now)

    const trajectoryTasks = parseTrajectories(raw)
    const mainTrajectoryCount = trajectoryTasks.filter(t => !t.isSubagent).length
    const priorityIds = [...new Set([focusedTaskId, pinnedTaskId].filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
    const needConvList =
      mainTrajectoryCount < MAX_TASKS || priorityIds.some(id => !trajectoryTasks.some(t => t.cascadeId === id))

    let allTasks = trajectoryTasks
    if (needConvList) {
      const convRaw = await callEndpoint(
        endpoint,
        LIST_CONVERSATIONS_PATH,
        { pageSize: MAX_TASKS, includeArchived: false, parentConversationId: '' },
        { timeoutMs: 2500, maxBytes: 2 * 1024 * 1024 },
      )
      const convTasks = convRaw ? parseConversationList(convRaw) : []
      if (convTasks.length > 0) allTasks = mergeTaskSummaries(trajectoryTasks, convTasks)
    }

    // Keep main tasks + any currently running subagents; drop idle/historical subagents to stay focused.
    const visible = allTasks.filter(t => !t.isSubagent || t.isRunning).slice(0, MAX_TASKS)

    // Always include the currently viewed (focused) or pinned conversation even if it is an older historical chat.
    for (const id of priorityIds) {
      if (visible.some(t => t.cascadeId === id)) continue
      const fromAll = allTasks.find(t => t.cascadeId === id)
      if (fromAll) {
        visible.push(fromAll)
      } else {
        const fetched = await fetchConversationTask(endpoint, id)
        if (fetched) visible.push(fetched)
      }
    }

    const enriched = new Array(visible.length)
    for (let i = 0; i < visible.length; i += FETCH_CONCURRENCY) {
      const slice = visible.slice(i, i + FETCH_CONCURRENCY)
      const results = await Promise.all(
        slice.map(async task => {
          try {
            const ctx = await fetchTaskContext(endpoint, task)
            const model = ctx?.model || task.model || ''
            const modelLabel = ctx?.modelLabel || resolveModelLabel(model, modelNames)
            if (!ctx) {
              return {
                ...task,
                model,
                modelLabel,
                contextUsed: 0,
                contextLimit: inferContextLimit(model, 0, modelNames),
                usagePercent: 0,
                isEstimated: false,
                hasContext: false,
                inputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                breakdown: [],
              }
            }
            return {
              ...task,
              model,
              modelLabel,
              contextUsed: ctx.contextUsed,
              contextLimit: ctx.contextLimit,
              usagePercent: ctx.usagePercent,
              isEstimated: ctx.isEstimated,
              hasContext: ctx.contextUsed > 0,
              inputTokens: ctx.inputTokens,
              cacheReadTokens: ctx.cacheReadTokens,
              cacheCreationTokens: ctx.cacheCreationTokens,
              outputTokens: ctx.outputTokens,
              breakdown: ctx.breakdown,
            }
          } catch (err) {
            if (log?.warn) log.warn('antigravity task context read failed:', task.cascadeId.slice(0, 8), err.message)
            return null
          }
        }),
      )
      for (let j = 0; j < results.length; j++) enriched[i + j] = results[j]
    }

    const tasks = enriched.filter(Boolean)
    return { ok: true, tasks, updatedAt: now, endpoint }
  }

  return { readTasks, setEndpoint, clearCache }
}

module.exports = {
  MODEL_CONTEXT_LIMITS,
  STATIC_MODEL_NAMES,
  DEFAULT_CONTEXT_LIMIT,
  inferContextLimit,
  resolveModelLabel,
  parseModelCatalog,
  parseTrajectories,
  parseConversationSummary,
  parseConversationList,
  mergeTaskSummaries,
  parseGeneratorMetadataContext,
  parseStepsContext,
  matchTaskByTitles,
  resolveActiveTask,
  createContextReader,
}
