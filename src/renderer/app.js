const pet = document.getElementById('pet')
const avatar = document.getElementById('avatar')
const bubble = document.getElementById('bubble')
const bubbleTitle = document.getElementById('bubble-title')
const modelBar = document.getElementById('model-bar')
const agTabs = document.getElementById('ag-tabs')
const rows = document.getElementById('rows')
const empty = document.getElementById('empty')
const updated = document.getElementById('updated')
const note = document.getElementById('note')
const badges = document.getElementById('badges')

const LABELS = { five_hour: '5 小时', seven_day: '本周', spend_limit: '消费上限', quota: '周期额度' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit', 'quota']
const GROUP_SHORT = {
  gemini: { label: 'Gem', color: 'gemini' },
  gemini_argon: { label: 'Argon', color: 'flash' },
  gemini_pro: { label: 'Pro', color: 'gemini' },
  gemini_flash: { label: 'Flash', color: 'flash' },
  claude: { label: 'Cla', color: 'claude' },
  third_party: { label: 'Cla', color: 'claude' },
}
const ALERT_AT = [80, 95]
const AUTO_HIDE_MS = 7000
const TURN_NOTE_MS = 20000 // how long a finished-turn note stays; the pointer on it holds it

let usage = null
let soundOn = true
let pinned = false
let hideTimer = null
let shownPercent = {} // what each row currently displays, for the rolling animation
let lastAlertLevel = {}
let initializedHosts = new Set()
let agTab = 'all' // 'all' | 'quota' | 'tasks'

// ---------- numbers ----------

function effectivePercent(limit) {
  if (limit.resetsAt && Date.parse(limit.resetsAt) <= Date.now()) return 0
  return limit.percentUsed
}

function level(percent) {
  return percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : ''
}

function resetText(limit) {
  if (!limit.resetsAt) return ''
  const at = new Date(limit.resetsAt)
  const ms = at - Date.now()
  if (ms <= 0) return '已重置'
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟后重置`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置`
  const day = '日一二三四五六'[at.getDay()]
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `周${day} ${hh}:${mm} 重置`
}

function agoText(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60000)
  if (minutes < 1) return '刚刚更新'
  if (minutes < 60) return `${minutes} 分钟前更新`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前更新`
  return `${Math.floor(minutes / 1440)} 天前更新`
}

function shortAgo(ms) {
  if (!ms) return ''
  const minutes = Math.floor((Date.now() - ms) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}m前`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h前`
  return `${Math.floor(minutes / 1440)}d前`
}

function formatTokens(n) {
  const num = Number(n) || 0
  if (num < 1000) return String(Math.round(num))
  if (num >= 1000000) {
    const m = num / 1000000
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`
  }
  const k = num / 1000
  if (num % 1000 === 0 || k >= 100) return `${Math.round(k)}K`
  return `${k.toFixed(1).replace(/\.0$/, '')}K`
}

function shortModelName(label) {
  if (!label) return ''
  return String(label)
    .replace(/\s*\((?:Extra High|High|Medium|Low|Thinking)\)/i, m => {
      const inner = m.slice(m.indexOf('(') + 1, -1).toLowerCase()
      if (inner === 'extra high') return ' 超高'
      if (inner === 'high') return ' 高'
      if (inner === 'medium') return ' 中'
      if (inner === 'low') return ' 低'
      return ''
    })
    .trim()
}

function taskTooltip(task) {
  const stateLabel = task.isRunning ? '运行中' : task.isWaiting ? '等待中' : '空闲'
  const lines = [`${task.title}（${stateLabel}）`]
  if (task.hasContext) {
    const rem = Math.max(0, (task.contextLimit || 0) - (task.contextUsed || 0))
    const est = task.isEstimated ? '（估算）' : ''
    lines.push(
      `上下文：${task.contextUsed.toLocaleString()} / ${task.contextLimit.toLocaleString()} (${task.usagePercent}%)${est} · 剩余 ${formatTokens(rem)}`,
    )
    if (task.inputTokens || task.cacheReadTokens || task.outputTokens) {
      const parts = []
      if (task.inputTokens) parts.push(`输入 ${formatTokens(task.inputTokens)}`)
      if (task.cacheReadTokens) parts.push(`缓存 ${formatTokens(task.cacheReadTokens)}`)
      if (task.cacheCreationTokens) parts.push(`写入缓存 ${formatTokens(task.cacheCreationTokens)}`)
      if (task.outputTokens) parts.push(`输出 ${formatTokens(task.outputTokens)}`)
      if (parts.length > 0) lines.push(`明细：${parts.join(' · ')}`)
    }
    if (Array.isArray(task.breakdown) && task.breakdown.length > 0) {
      const top = task.breakdown.slice(0, 4).map(b => `${b.name} ${formatTokens(b.tokens)}`)
      lines.push(`构成：${top.join(' · ')}`)
    }
  } else {
    lines.push('上下文：尚未收到模型回复')
  }
  const metaParts = []
  if (task.modelLabel || task.model) metaParts.push(task.modelLabel || task.model)
  if (task.workspace) metaParts.push(task.workspace)
  if (task.stepCount) metaParts.push(`${task.stepCount} 步`)
  if (metaParts.length > 0) lines.push(metaParts.join(' · '))
  lines.push(task.pinned ? '点此取消固定，恢复自动跟随' : '点此固定追踪该任务上下文')
  return lines.join('\n')
}

// Rolls a number from its last shown value to the new one.
function rollTo(el, key, target) {
  const from = shownPercent[key] ?? 0
  shownPercent[key] = target
  const start = performance.now()
  const step = now => {
    const t = Math.min(1, (now - start) / 700)
    const eased = 1 - Math.pow(1 - t, 3)
    el.textContent = `${Math.round(from + (target - from) * eased)}%`
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// ---------- drawing ----------

function hostOf(u) {
  return u?.host === 'antigravity' ? 'antigravity' : 'claude'
}

function sortedLimits(list) {
  if (!Array.isArray(list)) return []
  return [...list].sort((a, b) => {
    const ai = ORDER.indexOf(a.kind)
    const bi = ORDER.indexOf(b.kind)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
}

function createRowElement(key, limit, color, inlineReset = false) {
  const row = document.createElement('div')
  row.className = 'row'
  row.dataset.key = key
  row.dataset.kind = limit.kind
  if (color) row.dataset.color = color
  row.innerHTML = inlineReset
    ? `
    <div class="row-top"><span class="row-label"><span class="name"></span><span class="muted reset"></span></span><b class="pct">0%</b></div>
    <div class="bar"><i></i></div>`
    : `
    <div class="row-top"><span class="name"></span><b class="pct">0%</b></div>
    <div class="bar"><i></i></div>
    <div class="muted reset"></div>`
  return row
}

function updateRowElement(row, key, limit, labelOverride, inlineReset = false) {
  const percent = Math.round(effectivePercent(limit))
  row.querySelector('.name').textContent = labelOverride || limit.label || LABELS[limit.kind] || limit.kind
  const fill = row.querySelector('.bar i')
  fill.style.width = `${Math.min(100, percent)}%`
  fill.className = level(percent)
  const rst = resetText(limit)
  row.querySelector('.reset').textContent = inlineReset && rst ? `· ${rst}` : rst
  const pctEl = row.querySelector('.pct')
  if (shownPercent[key] !== percent) rollTo(pctEl, key, percent)
  else pctEl.textContent = `${percent}%`
}

function emptyMessageFor(u) {
  if (hostOf(u) !== 'antigravity') {
    return '还没有数据。在 Claude 的 Code 标签页里发一条消息，额度就会出现在这里。'
  }
  if (u?.quotaStatus === 'not-running') {
    return '未检测到正在运行的反重力。启动反重力后会自动读取每周限额和 5 小时限额。'
  }
  if (u?.quotaStatus === 'missing-cli') {
    return '未检测到反重力本地额度接口，也没有可用的外部命令。请先启动反重力，或在右键菜单查看说明。'
  }
  if (u?.quotaStatus === 'needs-login') {
    return '需要登录一次 Google 账号以读取反重力额度：右键点击鲸鱼，选择「登录 Google 账号，读取反重力额度…」。'
  }
  if (u?.quotaStatus === 'logging-in') {
    return '正在浏览器中登录 Google 账号，完成后额度会自动出现…'
  }
  if (u?.quotaStatus === 'error') {
    return `读取 Antigravity 额度失败：${u.quotaError || '请查看日志'}`
  }
  return '还没有 Antigravity 额度数据。启动反重力后会自动读取，也可以写入 ~/.gemini/antigravity/whale/usage.json。'
}

function renderClaude() {
  const limits = sortedLimits(usage?.limits)
  bubbleTitle.textContent = 'Claude 额度'
  modelBar.classList.add('hidden')
  agTabs.classList.add('hidden')
  empty.textContent = emptyMessageFor(usage)
  empty.classList.toggle('hidden', limits.length > 0)
  updated.textContent = usage?.updatedAt ? agoText(usage.updatedAt) : ''

  // Remove any Antigravity wrappers before updating flat rows
  for (const node of rows.querySelectorAll('.group, .task-card, .section-title')) node.remove()

  for (const limit of limits) {
    const key = `claude:${limit.kind}`
    let row = rows.querySelector(`.row[data-key="${key}"]`)
    if (!row) {
      row = createRowElement(key, limit, null)
      rows.appendChild(row)
    }
    updateRowElement(row, key, limit)
  }
  for (const row of rows.querySelectorAll(':scope > .row')) {
    if (!limits.some(l => `claude:${l.kind}` === row.dataset.key)) row.remove()
  }

  // Pills under the pet: 5h (blue) + 7d (purple)
  const pillNodes = []
  for (const kind of ['five_hour', 'seven_day']) {
    const limit = limits.find(l => l.kind === kind)
    if (!limit) continue
    const percent = Math.round(effectivePercent(limit))
    const pill = document.createElement('span')
    pill.dataset.kind = kind
    pill.className = `pill ${level(percent)}`
    pill.textContent = `${percent}%`
    pill.title = `${LABELS[kind]}：${percent}%`
    pillNodes.push(pill)
  }
  badges.classList.remove('wide')
  badges.replaceChildren(...pillNodes)
}

function createTaskCard(task) {
  const card = document.createElement('div')
  card.className = `task-card${task.active ? ' active' : ''}`
  card.dataset.task = task.cascadeId
  card.title = taskTooltip(task)
  card.addEventListener('click', e => {
    e.stopPropagation()
    window.whale.selectTask(task.pinned ? null : task.cascadeId)
  })

  const head = document.createElement('div')
  head.className = 'task-head'

  const titleWrap = document.createElement('div')
  titleWrap.className = 'task-title-wrap'
  const dot = document.createElement('span')
  dot.className = `task-dot${task.isRunning ? ' running' : task.isWaiting ? ' waiting' : ''}`
  titleWrap.append(dot, el('span', 'task-title', task.title))

  const right = document.createElement('div')
  right.className = 'task-right'
  if (task.isSubagent) right.append(el('span', 'task-tag', '子代理'))
  if (task.active) right.append(el('span', 'task-tag primary', task.pinned ? '已固定' : '当前'))

  const pct = Math.round(task.usagePercent || 0)
  const pctEl = el('b', 'task-pct', task.hasContext ? `${pct}%` : '--')
  right.append(pctEl)
  head.append(titleWrap, right)
  card.appendChild(head)

  const bar = document.createElement('div')
  bar.className = 'bar'
  const fill = document.createElement('i')
  fill.style.width = `${task.hasContext ? Math.min(100, pct) : 0}%`
  fill.className = task.hasContext ? level(pct) : ''
  bar.appendChild(fill)
  card.appendChild(bar)

  const meta = document.createElement('div')
  meta.className = 'task-meta'
  const tokensText = task.hasContext
    ? `${task.isEstimated ? '~' : ''}${formatTokens(task.contextUsed)} / ${formatTokens(task.contextLimit)}`
    : '暂无上下文'
  const subParts = []
  const mLabel = shortModelName(task.modelLabel || task.model)
  if (mLabel) subParts.push(mLabel)
  if (task.isRunning) subParts.push('运行中')
  else if (task.lastModifiedMs) subParts.push(shortAgo(task.lastModifiedMs))
  meta.append(el('span', 'task-tokens', tokensText), el('span', 'task-sub', subParts.join(' · ')))
  card.appendChild(meta)

  return card
}

function renderAntigravityTabs(contextEnabled, taskCount) {
  if (!contextEnabled) {
    agTabs.classList.add('hidden')
    agTabs.replaceChildren()
    return
  }
  agTabs.classList.remove('hidden')
  const defs = [
    { id: 'all', label: '全部' },
    { id: 'quota', label: '额度' },
    { id: 'tasks', label: taskCount > 0 ? `上下文 (${taskCount})` : '上下文' },
  ]
  const nodes = defs.map(def => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `ag-tab${agTab === def.id ? ' active' : ''}`
    btn.textContent = def.label
    btn.addEventListener('click', e => {
      e.stopPropagation()
      if (agTab !== def.id) {
        agTab = def.id
        renderAntigravity()
      }
    })
    return btn
  })
  agTabs.replaceChildren(...nodes)
}

function renderAntigravity() {
  const groups = Array.isArray(usage?.groups) ? usage.groups : []
  const contextEnabled = usage?.contextEnabled !== false
  const tasks = contextEnabled && Array.isArray(usage?.tasks) ? usage.tasks : []
  if (!contextEnabled && agTab === 'tasks') agTab = 'all'

  bubbleTitle.textContent = contextEnabled ? 'Antigravity' : 'Antigravity 额度'
  const latestUpdate = Math.max(usage?.updatedAt || 0, usage?.tasksUpdatedAt || 0)
  updated.textContent = latestUpdate ? agoText(latestUpdate) : ''

  if (usage?.activeModel || (usage?.overrideGroup && usage.overrideGroup !== 'auto')) {
    const parts = []
    if (usage.activeModel) parts.push(`模型：${usage.activeModel}`)
    if (usage.overrideGroup && usage.overrideGroup !== 'auto') parts.push(`已固定：${usage.activeGroupLabel || usage.overrideGroup}`)
    modelBar.textContent = parts.join(' · ')
    modelBar.title = modelBar.textContent
    modelBar.classList.remove('hidden')
  } else {
    modelBar.classList.add('hidden')
  }

  renderAntigravityTabs(contextEnabled, tasks.length)

  const showQuota = !contextEnabled || agTab === 'all' || agTab === 'quota'
  const showTasks = contextEnabled && (agTab === 'all' || agTab === 'tasks')
  const nodes = []

  if (showQuota && groups.length > 0) {
    if (showTasks && tasks.length > 0) {
      const sec = el('div', 'section-title')
      sec.append(el('span', '', '订阅额度'), el('span', '', `${groups.length} 组`))
      nodes.push(sec)
    }
    for (const group of groups) {
      const card = document.createElement('div')
      card.className = `group${group.active ? ' active' : ''}`
      card.dataset.group = group.id
      if (group.color) card.dataset.color = group.color

      const head = document.createElement('div')
      head.className = 'group-head'
      const locked = usage?.overrideGroup === group.id
      head.title = locked ? '点此恢复按模型自动切换' : '点此固定查看该分组额度'
      head.append(el('span', '', group.label || group.id))
      if (group.active) {
        head.append(el('span', 'group-tag', locked ? '已固定' : '当前'))
      }
      head.addEventListener('click', e => {
        e.stopPropagation()
        window.whale.selectGroup(locked ? 'auto' : group.id)
      })
      card.appendChild(head)

      for (const limit of sortedLimits(group.limits)) {
        const key = `antigravity:${group.id}:${limit.kind}`
        const row = createRowElement(key, limit, group.color, true)
        updateRowElement(row, key, limit, null, true)
        card.appendChild(row)
      }
      nodes.push(card)
    }
  }

  if (showTasks && tasks.length > 0) {
    if (showQuota && groups.length > 0) {
      const sec = el('div', 'section-title')
      sec.append(el('span', '', '任务上下文'), el('span', '', `${tasks.length} 个`))
      nodes.push(sec)
    }
    for (const task of tasks) {
      nodes.push(createTaskCard(task))
    }
  }

  rows.replaceChildren(...nodes)

  const isEmpty = nodes.length === 0
  if (isEmpty) {
    empty.textContent =
      agTab === 'tasks'
        ? '未检测到反重力任务。启动反重力并打开任意对话后，这里会实时显示每个任务的上下文占用。'
        : emptyMessageFor(usage)
  }
  empty.classList.toggle('hidden', !isEmpty)

  // Pills under the pet: active model's quota group (up to 2 windows) + active task's context usage
  const activeLimits = sortedLimits(usage?.limits).slice(0, 2)
  const pillNodes = activeLimits.map((limit, idx) => {
    const percent = Math.round(effectivePercent(limit))
    const pill = document.createElement('span')
    pill.dataset.kind = limit.kind
    if (limit.color) pill.dataset.color = limit.color
    pill.className = `pill ${level(percent)}`
    const prefix = idx === 0 && limit.shortLabel ? `${limit.shortLabel} ` : ''
    pill.textContent = `${prefix}${percent}%`
    const winLabel = limit.label || LABELS[limit.kind] || limit.kind
    pill.title = `${limit.groupLabel || ''} ${winLabel}：${percent}%`.trim()
    return pill
  })

  const activeTask = contextEnabled ? usage?.activeTask : null
  if (activeTask && activeTask.hasContext) {
    const pct = Math.round(activeTask.usagePercent || 0)
    const pill = document.createElement('span')
    pill.dataset.kind = 'context'
    pill.className = `pill ${level(pct)}`
    pill.textContent = `Ctx ${pct}%`
    pill.title = taskTooltip(activeTask)
    pillNodes.push(pill)
  }

  badges.classList.toggle('wide', pillNodes.length >= 3)
  badges.replaceChildren(...pillNodes)
}

function render() {
  if (hostOf(usage) === 'antigravity') renderAntigravity()
  else renderClaude()
}

// ---------- bubble ----------

function showBubble({ pin = false } = {}) {
  hideNote({ dismiss: true })
  render()
  bubble.classList.remove('hidden')
  clearTimeout(hideTimer)
  pinned = pin
  if (!pin) hideTimer = setTimeout(hideBubble, AUTO_HIDE_MS)
}

function hideBubble() {
  bubble.classList.add('hidden')
  pinned = false
}

function alertEntries(u) {
  if (!u) return []
  if (hostOf(u) === 'antigravity') {
    const out = []
    for (const g of u.groups || []) {
      for (const limit of g.limits || []) {
        out.push({ key: `antigravity:${g.id}:${limit.kind}`, limit })
      }
    }
    return out
  }
  return sortedLimits(u.limits).map(limit => ({ key: `claude:${limit.kind}`, limit }))
}

// Pops the bubble once when a window first crosses 80% or 95%.
function checkAlerts() {
  const host = hostOf(usage)
  const entries = alertEntries(usage)
  if (!initializedHosts.has(host)) {
    if (entries.length > 0) initializedHosts.add(host)
    for (const { key, limit } of entries) {
      lastAlertLevel[key] = ALERT_AT.filter(a => effectivePercent(limit) >= a).pop() ?? 0
    }
    return
  }
  for (const { key, limit } of entries) {
    const percent = effectivePercent(limit)
    const reached = ALERT_AT.filter(a => percent >= a).pop() ?? 0
    const before = lastAlertLevel[key]
    lastAlertLevel[key] = reached
    if (before !== undefined && reached > before) {
      showBubble()
      bounce()
    }
  }
}

// ---------- sound ----------

let audio = null
function pop(high) {
  if (!soundOn) return
  audio ??= new AudioContext()
  const t = audio.currentTime
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(high ? 720 : 520, t)
  osc.frequency.exponentialRampToValueAtTime(high ? 1100 : 260, t + 0.09)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
  osc.connect(gain).connect(audio.destination)
  osc.start(t)
  osc.stop(t + 0.13)
}

// A tone for the reminders, starting `at` seconds from now
function tone(freq, at, length, type = 'sine', volume = 0.14) {
  const t = audio.currentTime + at
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
  osc.connect(gain).connect(audio.destination)
  osc.start(t)
  osc.stop(t + length + 0.02)
}

// 'done': two rising notes when a turn ends. 'wait': two short beeps and a higher one, to get attention.
function chime(kind) {
  if (!soundOn) return
  audio ??= new AudioContext()
  if (audio.state === 'suspended') audio.resume()
  if (kind === 'done') {
    tone(784, 0.02, 0.35)
    tone(1047, 0.14, 0.55)
  } else {
    tone(988, 0.02, 0.12, 'triangle')
    tone(988, 0.18, 0.12, 'triangle')
    tone(1319, 0.34, 0.3, 'triangle')
  }
}

function bounce() {
  pet.classList.remove('bounce')
  void pet.offsetWidth
  pet.classList.add('bounce')
}

// ---------- reminders ----------

let noteKind = null // 'wait' or 'turn' while the note shows
let noteTimer = null
let noteLeft = 0 // ms the note has left to show; 0 when it stays until answered
let noteDeadline = 0
let overNote = false
let dismissedWait = null // the wait the person closed; it stays closed until another one opens

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function showNote(kind, children, ms) {
  bubble.classList.add('hidden')
  pinned = false
  note.replaceChildren(...children)
  note.className = kind
  noteKind = kind
  clearTimeout(noteTimer)
  noteLeft = ms ?? 0
  if (noteLeft && !overNote) startNoteTimer()
}

function startNoteTimer() {
  noteDeadline = Date.now() + noteLeft
  noteTimer = setTimeout(hideNote, noteLeft)
}

// The pointer on the note holds it; leaving runs the rest of its time
function holdNote(over) {
  if (over === overNote) return
  overNote = over
  if (!noteKind || !noteLeft) return
  clearTimeout(noteTimer)
  if (over) noteLeft = Math.max(noteDeadline - Date.now(), 0)
  else startNoteTimer()
}

function hideNote({ dismiss = false } = {}) {
  if (dismiss && noteKind === 'wait') dismissedWait = note.dataset.key
  clearTimeout(noteTimer)
  note.className = 'hidden'
  noteKind = null
}

function waitLines(wait, others) {
  const name = wait.host === 'antigravity' ? 'Antigravity' : 'Claude'
  const [title, detail] =
    wait.kind === 'question' ? [`${name} 在等你回答问题`, '']
    : wait.tool === 'ExitPlanMode' ? [`${name} 在等你确认计划`, '']
    : [`${name} 在等你批准`, wait.tool ? `要用 ${wait.tool}` : '']
  const lines = [el('b', '', title)]
  if (detail) lines.push(el('span', 'muted', detail))
  if (others > 0) lines.push(el('span', 'muted', `还有 ${others} 个会话也在等你`))
  return lines
}

// Open waits from every session, newest last; `fresh` when one just opened.
function onWaits({ active, fresh }) {
  const wait = active[active.length - 1]
  if (!wait) {
    dismissedWait = null
    if (noteKind === 'wait') hideNote()
    return
  }
  const key = `${wait.host || 'claude'}:${wait.session}:${wait.since}`
  if (fresh) {
    chime('wait')
    bounce()
  }
  if (key === dismissedWait) return
  if (noteKind === 'wait' && note.dataset.key === key) return
  // An old wait does not cover the usage bubble the person opened
  if (!fresh && pinned && !bubble.classList.contains('hidden')) return
  note.dataset.key = key
  showNote('wait', waitLines(wait, active.length - 1))
}

// A finished turn that used at least 1% of a window
function onTurn(payload) {
  const deltas = payload?.deltas ? payload.deltas : payload
  if (!deltas) return
  chime('done')
  bounce()
  if (noteKind === 'wait') return // the wait matters more
  const children = [el('span', '', '回复完了，这轮用了')]
  const entries = Object.entries(deltas).filter(([, v]) => v > 0)
  entries.sort(([a], [b]) => {
    const ai = ORDER.indexOf(a.includes(':') ? a.split(':')[1] : a)
    const bi = ORDER.indexOf(b.includes(':') ? b.split(':')[1] : b)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
  for (const [rawKey, delta] of entries) {
    if (rawKey.includes(':')) {
      const [groupId, kind] = rawKey.split(':')
      const meta = GROUP_SHORT[groupId] || { label: groupId, color: 'gemini' }
      const chip = el('span', 'delta', `${meta.label} +${delta}%`)
      chip.dataset.kind = kind
      chip.dataset.color = meta.color
      chip.title = `${meta.label} ${LABELS[kind] || kind}`
      children.push(chip)
    } else {
      const chip = el('span', 'delta', `+${delta}%`)
      chip.dataset.kind = rawKey
      chip.title = LABELS[rawKey] ?? rawKey
      children.push(chip)
    }
  }
  showNote('turn', children, TURN_NOTE_MS)
}

note.addEventListener('click', () => hideNote({ dismiss: true }))

// ---------- pointer: click, press, drag ----------

let press = null

pet.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  pet.setPointerCapture(e.pointerId)
  press = { x: e.screenX, y: e.screenY, moved: false }
  pet.classList.add('pressed')
  pop(false)
  window.whale.dragStart()
})

pet.addEventListener('pointermove', e => {
  if (!press) return
  if (!press.moved && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.moved = true
    pet.classList.add('dragging')
  }
  if (press.moved) window.whale.dragMove()
})

pet.addEventListener('pointerup', () => {
  if (!press) return
  const wasClick = !press.moved
  press = null
  pet.classList.remove('pressed', 'dragging')
  window.whale.dragEnd()
  pop(true)
  bounce()
  if (wasClick) {
    if (bubble.classList.contains('hidden') || !pinned) showBubble({ pin: true })
    else hideBubble()
  }
})

// Clicks on transparent parts of the window go through to the app underneath.
let overPet = false
document.addEventListener('mousemove', e => {
  const node = document.elementFromPoint(e.clientX, e.clientY)
  const over = Boolean(
    node &&
      (pet.contains(node) ||
        (!bubble.classList.contains('hidden') && bubble.contains(node)) ||
        (noteKind && note.contains(node))),
  )
  holdNote(Boolean(node && noteKind && note.contains(node)))
  if (over !== overPet || press) {
    overPet = over || Boolean(press)
    window.whale.mouseOverPet(overPet)
  }
})
document.addEventListener('mouseleave', () => {
  holdNote(false)
  if (press) return
  overPet = false
  window.whale.mouseOverPet(false)
})

bubble.addEventListener('click', hideBubble)

// Right-clicking the character opens the same menu as the tray icon.
pet.addEventListener('contextmenu', e => {
  e.preventDefault()
  window.whale.openMenu()
})

// Scrolling over the character makes it bigger or smaller.
pet.addEventListener('wheel', e => {
  e.preventDefault()
  window.whale.resizeStep(e.deltaY < 0 ? 1 : -1)
}, { passive: false })

// ---------- wiring ----------

window.whale.onConfig(config => {
  avatar.src = config.skinUrl
  soundOn = config.sound
})

window.whale.onUsage(next => {
  usage = next
  render()
  checkAlerts()
})

window.whale.onShowBubble(() => showBubble({ pin: true }))
window.whale.onWaits(onWaits)
window.whale.onTurn(onTurn)

setInterval(render, 30000)
