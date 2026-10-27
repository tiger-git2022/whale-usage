const pet = document.getElementById('pet')
const avatar = document.getElementById('avatar')
const bubble = document.getElementById('bubble')
const rows = document.getElementById('rows')
const empty = document.getElementById('empty')
const updated = document.getElementById('updated')
const note = document.getElementById('note')

const LABELS = { five_hour: '5 小时', seven_day: '本周', spend_limit: '消费上限' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const ALERT_AT = [80, 95]
const AUTO_HIDE_MS = 7000
const TURN_NOTE_MS = 6000

let usage = null
let soundOn = true
let pinned = false
let hideTimer = null
let shownPercent = {} // what each row currently displays, for the rolling animation
let lastAlertLevel = {}

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

function sortedLimits() {
  if (!usage || !Array.isArray(usage.limits)) return []
  return [...usage.limits].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
}

function render() {
  const limits = sortedLimits()
  empty.classList.toggle('hidden', limits.length > 0)
  updated.textContent = usage?.updatedAt ? agoText(usage.updatedAt) : ''

  for (const limit of limits) {
    let row = rows.querySelector(`[data-kind="${limit.kind}"]`)
    if (!row) {
      row = document.createElement('div')
      row.className = 'row'
      row.dataset.kind = limit.kind
      row.innerHTML = `
        <div class="row-top"><span class="name"></span><b class="pct">0%</b></div>
        <div class="bar"><i></i></div>
        <div class="muted reset"></div>`
      rows.appendChild(row)
    }
    const percent = Math.round(effectivePercent(limit))
    row.querySelector('.name').textContent = LABELS[limit.kind] ?? limit.kind
    const fill = row.querySelector('.bar i')
    fill.style.width = `${Math.min(100, percent)}%`
    fill.className = level(percent)
    row.querySelector('.reset').textContent = resetText(limit)
    if (shownPercent[limit.kind] !== percent) rollTo(row.querySelector('.pct'), limit.kind, percent)
  }
  for (const row of rows.querySelectorAll('.row')) {
    if (!limits.some(l => l.kind === row.dataset.kind)) row.remove()
  }

  for (const pill of document.querySelectorAll('.pill')) {
    const limit = limits.find(l => l.kind === pill.dataset.kind)
    if (!limit) {
      pill.className = 'pill hidden'
      continue
    }
    const percent = Math.round(effectivePercent(limit))
    pill.textContent = `${percent}%`
    pill.title = `${LABELS[limit.kind]}：${percent}%`
    pill.className = `pill ${level(percent)}`
  }
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

// Pops the bubble once when a window first crosses 80% or 95%.
function checkAlerts() {
  for (const limit of sortedLimits()) {
    const percent = effectivePercent(limit)
    const reached = ALERT_AT.filter(a => percent >= a).pop() ?? 0
    const before = lastAlertLevel[limit.kind]
    lastAlertLevel[limit.kind] = reached
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
  if (ms) noteTimer = setTimeout(hideNote, ms)
}

function hideNote({ dismiss = false } = {}) {
  if (dismiss && noteKind === 'wait') dismissedWait = note.dataset.key
  clearTimeout(noteTimer)
  note.className = 'hidden'
  noteKind = null
}

function waitLines(wait, others) {
  const [title, detail] =
    wait.kind === 'question' ? ['Claude 在等你回答问题', '']
    : wait.tool === 'ExitPlanMode' ? ['Claude 在等你确认计划', '']
    : ['Claude 在等你批准', wait.tool ? `要用 ${wait.tool}` : '']
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
  const key = `${wait.session}:${wait.since}`
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
function onTurn(deltas) {
  chime('done')
  bounce()
  if (noteKind === 'wait') return // the wait matters more
  const children = [el('span', '', '回复完了，这轮用了')]
  for (const kind of ORDER) {
    if (!(deltas[kind] > 0)) continue
    const chip = el('span', 'delta', `+${deltas[kind]}%`)
    chip.dataset.kind = kind
    chip.title = LABELS[kind] ?? kind
    children.push(chip)
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

// Clicks on transparent parts of the window go through to Claude underneath.
let overPet = false
document.addEventListener('mousemove', e => {
  const el = document.elementFromPoint(e.clientX, e.clientY)
  const over = Boolean(
    el &&
      (pet.contains(el) ||
        (!bubble.classList.contains('hidden') && bubble.contains(el)) ||
        (noteKind && note.contains(el))),
  )
  if (over !== overPet || press) {
    overPet = over || Boolean(press)
    window.whale.mouseOverPet(overPet)
  }
})
document.addEventListener('mouseleave', () => {
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

let firstUsage = true
window.whale.onUsage(next => {
  usage = next
  render()
  if (firstUsage) {
    firstUsage = false
    for (const limit of sortedLimits()) {
      lastAlertLevel[limit.kind] = ALERT_AT.filter(a => effectivePercent(limit) >= a).pop() ?? 0
    }
    return
  }
  checkAlerts()
})

window.whale.onShowBubble(() => showBubble({ pin: true }))
window.whale.onWaits(onWaits)
window.whale.onTurn(onTurn)

setInterval(render, 30000)
