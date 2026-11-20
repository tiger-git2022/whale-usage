const { app, BrowserWindow, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const log = require('./log')
const menu = require('./menu')
const sessions = require('./sessions')
const updater = require('./updater')
const webusage = require('./webusage')
const antigravity = require('./antigravity')
const composer = require('./composer')
const limits = require('./limits')
const { targetState } = require('./win32')

// The widget window at 100% size: the character sits at its bottom-right, the bubble above it.
// The page is zoomed by settings.scale, so these all scale together.
const BASE = { w: 320, h: 520, inset: 6, pet: 108 }
const SCALE_MIN = 0.4
const SCALE_MAX = 1.2
const SIZES = [
  { label: '小', scale: 0.5 },
  { label: '中', scale: 0.7 },
  { label: '大', scale: 0.9 },
  { label: '特大', scale: 1.1 },
]
const TARGETS = [
  { id: 'auto', label: '自动' },
  { id: 'claude', label: 'Claude' },
  { id: 'antigravity', label: '反重力' },
]
const TICK_MS = 80
const UPDATE_FIRST_CHECK_MS = 15 * 1000
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const SNAP_DIP = 28

const DEFAULT_HOST_ANCHOR = () => ({
  // Where the character's bottom-right corner sits, measured from the host window's bottom-right corner.
  anchor: { dx: 0, dy: -100 },
  // With snapToBox, the same corner measured from the input box's top-right corner instead.
  boxAnchor: { dx: 0, dy: 2 },
})

const DEFAULTS = {
  target: 'auto', // 'auto' | 'claude' | 'antigravity'
  anchor: { dx: 0, dy: -100 },
  snapToBox: true,
  boxAnchor: { dx: 0, dy: 2 },
  hostAnchors: {
    claude: DEFAULT_HOST_ANCHOR(),
    antigravity: DEFAULT_HOST_ANCHOR(),
  },
  closeLimitBanner: true, // press the close button of Claude's "approaching your weekly limit" banner
  scale: 0.7,
  showWhen: 'front', // 'front': only while the target app is active; 'open': whenever it is not minimized
  sound: true,
  notifyWait: true, // bubble and sound when a session waits for an answer or an approval
  notifyTurn: true, // bubble and sound when a turn ends having used at least 1% of a window
  skin: 'peek', // one of SKINS, or 'custom' for customSkin
  customSkin: null, // a picture the person chose, copied into the app's data folder
  autoUpdate: true, // look for a new release at start and every few hours, and install it right away
  antigravityQuotaEnabled: true,
  antigravityQuotaCommand: antigravity.DEFAULT_COMMAND,
  antigravityQuotaIntervalSec: antigravity.DEFAULT_INTERVAL_SEC,
  antigravityGroupOverride: 'auto', // 'auto' follows active model, or a specific group id
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
const usagePath = () =>
  process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'whale', 'usage.json')
    : path.join(os.homedir(), '.claude', 'whale', 'usage.json')
const sessionsDir = () => path.join(path.dirname(usagePath()), 'sessions')

// The bundled characters, each skins/<id>/character.png: square, transparent, cropped at the right
// and bottom edges so it peeks in from the corner.
const SKINS = [
  { id: 'peek', name: '探头' },
  { id: 'smile', name: '笑脸' },
]
const bundledSkin = id => path.join(__dirname, '..', 'skins', id, 'character.png')

let settings = { ...DEFAULTS }
let win = null
let tray = null
let cachedTarget = null
let activeHost = 'claude' // 'claude' | 'antigravity'
let dragging = null
let lastBounds = null
let isShown = false
let lastHostRect = null
let lastBoxRect = null // the input box the character sat on at the last tick (DIP), or null
let targetSeen = null // `${host}:${hwnd}` for logging when the followed window appears or changes
let pendingUpdate = null // the newer release found by the last check
let updateProgress = null // text while an update downloads
let weeklyPercent = null // Claude's highest weekly window's use, from the last usage read, or null
let lastUiModel = null // latest model name read from Antigravity via UI Automation
let lastUiModelAt = 0 // timestamp when lastUiModel was observed
let lastUiUsageSignature = null // latest "使用情况" panel snapshot read via UI Automation
let lastAntigravityPayload = null // latest renderer payload for Antigravity (for menu chips)

function cloneDefaults() {
  return {
    ...DEFAULTS,
    anchor: { ...DEFAULTS.anchor },
    boxAnchor: { ...DEFAULTS.boxAnchor },
    hostAnchors: {
      claude: DEFAULT_HOST_ANCHOR(),
      antigravity: DEFAULT_HOST_ANCHOR(),
    },
  }
}

function loadSettings() {
  const base = cloneDefaults()
  try {
    // Notepad and PowerShell may save the file with a byte order mark
    const text = fs.readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    settings = { ...base, ...parsed }
    const savedHosts = parsed.hostAnchors || {}
    settings.hostAnchors = {
      claude: {
        anchor: savedHosts.claude?.anchor || parsed.anchor || { ...DEFAULTS.anchor },
        boxAnchor: savedHosts.claude?.boxAnchor || parsed.boxAnchor || { ...DEFAULTS.boxAnchor },
      },
      antigravity: {
        anchor: savedHosts.antigravity?.anchor || { ...DEFAULTS.anchor },
        boxAnchor: savedHosts.antigravity?.boxAnchor || { ...DEFAULTS.boxAnchor },
      },
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('settings unreadable, using defaults:', err.message)
    settings = base
  }
  if (!TARGETS.some(t => t.id === settings.target)) settings.target = DEFAULTS.target
  // Before there were several characters, skin held the custom picture's path, or null
  if (settings.skin === null) settings.skin = DEFAULTS.skin
  if (settings.skin !== 'custom' && !SKINS.some(s => s.id === settings.skin)) {
    settings.customSkin = settings.skin
    settings.skin = 'custom'
  }
  activeHost = settings.target === 'antigravity' ? 'antigravity' : 'claude'
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

function anchorOf(host = activeHost) {
  settings.hostAnchors[host] ??= DEFAULT_HOST_ANCHOR()
  return settings.hostAnchors[host]
}

function skinPath() {
  if (settings.skin === 'custom' && settings.customSkin && fs.existsSync(settings.customSkin)) return settings.customSkin
  return bundledSkin(SKINS.some(s => s.id === settings.skin) ? settings.skin : DEFAULTS.skin)
}

function dims() {
  const k = settings.scale
  return { w: Math.round(BASE.w * k), h: Math.round(BASE.h * k), inset: BASE.inset * k, pet: BASE.pet * k }
}

function toDip(rect) {
  return screen.screenToDipRect(null, {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  })
}

// Window position for a given host rectangle (DIP) and the saved anchor; on the input box when it is known.
function boundsFor(hostRect, box, host = activeHost) {
  const d = dims()
  const pos = anchorOf(host)
  const petRight = box ? box.x + box.width + pos.boxAnchor.dx : hostRect.x + hostRect.width + pos.anchor.dx
  const petBottom = box ? box.y + pos.boxAnchor.dy : hostRect.y + hostRect.height + pos.anchor.dy
  return {
    x: Math.round(petRight + d.inset - d.w),
    y: Math.round(petBottom + d.inset - d.h),
    width: d.w,
    height: d.h,
  }
}

function setShown(show) {
  if (show === isShown) return
  isShown = show
  if (show) win.showInactive()
  else win.hide()
}

function setActiveHost(nextHost) {
  if (!nextHost || nextHost === activeHost) return
  activeHost = nextHost
  lastBounds = null
  lastBoxRect = null
  log.info('switched host to', activeHost)
  rebuildTray()
  sendUsage()
}

function tick() {
  if (!win || win.isDestroyed()) return
  let state
  try {
    state = targetState(cachedTarget, process.pid, settings.target)
  } catch (err) {
    log.error('host window lookup failed', err)
    return
  }
  cachedTarget = state.window
  const seen = state.window ? `${state.window.host}:${state.window.hwnd}` : ''
  if (seen !== targetSeen) {
    log.info(seen ? `following ${state.window.host} window ${state.window.hwnd} (pid ${state.window.pid})` : 'no host window')
    targetSeen = seen
    lastUiModel = null
    lastUiModelAt = 0
  }
  if (!state.window || state.minimized) return setShown(false)

  const host = state.window.host
  if (host !== activeHost) setActiveHost(host)

  const hostRect = toDip(state.rect)
  const inFront = state.hostInFront || state.selfInFront || dragging
  const show = settings.showWhen === 'open' || process.env.WHALE_FORCE_SHOW === '1' ? true : Boolean(inFront)

  // Only inspect UIA while the character shows, so a background window is left alone
  const wantBox = settings.snapToBox
  const wantDismiss = host === 'claude' && settings.closeLimitBanner
  const wantModel = host === 'antigravity'
  if ((wantBox || wantDismiss || wantModel) && show) {
    composer.poll(state.window.hwnd, {
      host,
      box: wantBox,
      dismiss: wantDismiss,
      weeklyPercent,
      detectModel: wantModel,
    })
  }
  if (host === 'antigravity' && show) {
    const uiModel = composer.modelOf(state.window.hwnd)
    if (uiModel && uiModel !== lastUiModel) {
      log.info('antigravity ui model:', uiModel)
      lastUiModel = uiModel
      lastUiModelAt = Date.now()
      sendUsage()
    }
    const uiTexts = composer.usageTextsOf(state.window.hwnd)
    if (uiTexts) {
      const sig = uiTexts.join('|')
      if (sig !== lastUiUsageSignature) {
        lastUiUsageSignature = sig
        const parsed = antigravity.parseUsagePanelTexts(uiTexts, Date.now())
        if (parsed) {
          log.info('synced antigravity usage from UI panel:', sig)
          antigravity.saveUsageFile(parsed)
          sendUsage()
        }
      }
    }
  }

  const boxRect = settings.snapToBox ? composer.boxOf(state.window.hwnd, state.outerRect) : null
  const box = boxRect ? toDip(boxRect) : null
  if (Boolean(box) !== Boolean(lastBoxRect)) log.info(box ? `on the input box ${JSON.stringify(box)}` : 'no input box, by the window corner')
  if (!dragging) {
    const b = boundsFor(hostRect, box, host)
    if (!lastBounds || b.x !== lastBounds.x || b.y !== lastBounds.y || b.width !== lastBounds.width) {
      win.setBounds(b)
      lastBounds = b
    }
  }
  lastHostRect = hostRect
  if (!dragging) lastBoxRect = box

  setShown(show)
}

// Snaps the character flush to the host's left or right edge when dropped close to it.
function anchorFromDrop(bounds) {
  const c = lastHostRect
  const d = dims()
  let petRight = bounds.x + d.w - d.inset
  const petBottom = bounds.y + d.h - d.inset
  if (lastBoxRect) {
    const box = lastBoxRect
    const right = box.x + box.width
    if (Math.abs(petRight - right) < SNAP_DIP) petRight = right
    let dy = petBottom - box.y
    if (Math.abs(dy - DEFAULTS.boxAnchor.dy) < SNAP_DIP) dy = DEFAULTS.boxAnchor.dy
    return { boxAnchor: { dx: Math.round(petRight - right), dy: Math.round(dy) } }
  }
  const right = c.x + c.width
  if (Math.abs(petRight - right) < SNAP_DIP) petRight = right
  if (Math.abs(petRight - d.pet - c.x) < SNAP_DIP) petRight = c.x + d.pet
  return { anchor: { dx: Math.round(petRight - right), dy: Math.round(petBottom - (c.y + c.height)) } }
}

let lastUsageText = null

function readClaudeUsage() {
  let file = null
  try {
    file = JSON.parse(fs.readFileSync(usagePath(), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('could not read usage file', err.message)
  }
  const usage = limits.merge(file, webusage.latest())
  const weekly = (usage?.limits || []).filter(l => String(l.kind).startsWith('seven_day')).map(l => l.percentUsed)
  weeklyPercent = weekly.length ? Math.max(...weekly) : null
  return usage ? { ...usage, host: 'claude', hostLabel: 'Claude' } : { host: 'claude', hostLabel: 'Claude', limits: [] }
}

function readAntigravityUsage() {
  const fileUsage = antigravity.readUsageFile()
  const merged = antigravity.mergeUsage(fileUsage, antigravity.latest())
  const hookState = antigravity.readState()
  const activeModel = antigravity.pickActiveModel({
    uiModel: lastUiModel,
    uiModelAt: lastUiModelAt,
    hookModel: hookState?.modelName,
    hookUpdatedAt: hookState?.updatedAt,
    usageModel: merged?.activeModel,
  })
  const pollerState = antigravity.state()
  const payload = antigravity.buildRendererPayload({
    usage: merged,
    activeModel,
    overrideGroup: settings.antigravityGroupOverride || 'auto',
    quotaStatus: pollerState.status,
    quotaError: pollerState.error,
  })
  lastAntigravityPayload = payload
  return payload
}

// Sends the current active host's usage to the renderer.
function sendUsage() {
  if (!win || win.isDestroyed()) return
  const payload = activeHost === 'antigravity' ? readAntigravityUsage() : readClaudeUsage()
  const summary =
    payload.host === 'antigravity'
      ? `antigravity[${payload.activeModel || 'auto'} -> ${payload.activeGroup || '-'}] ` +
        (payload.groups || [])
          .map(g => `${g.id}:${g.limits.map(l => `${Math.round(l.percentUsed)}%`).join('/')}`)
          .join(', ')
      : `claude ` + (payload.limits || []).map(l => `${l.kind} ${Math.round(l.percentUsed)}%`).join(', ')
  if (summary !== lastUsageText) log.info('usage', summary)
  lastUsageText = summary
  win.webContents.send('usage', payload)
}

function webUsageEntry() {
  const state = webusage.state()
  if (state === 'signed-in') return { type: 'item', id: 'web:logout', icon: 'E774', text: '从 claude.ai 读取全部额度', checked: true }
  // Usually claude.ai's security check has expired; its page in the window renews it and closes
  if (state === 'error') return { type: 'item', id: 'web:login', icon: 'E774', text: 'claude.ai 额度暂时读不到，点此重新打开…' }
  return { type: 'item', id: 'web:login', icon: 'E774', text: '登录 claude.ai，读取全部额度…' }
}

function antigravityQuotaEntry() {
  const st = antigravity.state()
  if (!settings.antigravityQuotaEnabled) {
    return { type: 'item', id: 'ag:toggle', icon: 'E72C', text: '启用反重力额度读取', checked: false }
  }
  if (st.status === 'not-running') {
    return { type: 'item', id: 'ag:refresh', icon: 'E72C', text: '未检测到反重力，启动后会自动读取（点此重试）' }
  }
  if (st.status === 'missing-cli') {
    return { type: 'item', id: 'ag:help', icon: 'E946', text: '反重力额度：未检测到 CLI（点此查看说明）' }
  }
  if (st.status === 'logging-in') {
    return { type: 'item', id: 'none', icon: 'E774', text: '正在浏览器中登录 Google 账号…', enabled: false }
  }
  if (st.status === 'needs-login') {
    return { type: 'item', id: 'ag:login', icon: 'E774', text: '登录 Google 账号，读取反重力额度…' }
  }
  if (st.status === 'error') {
    return { type: 'item', id: 'ag:refresh', icon: 'E72C', text: '反重力额度刷新失败，点此重试' }
  }
  return { type: 'item', id: 'ag:refresh', icon: 'E72C', text: '立即刷新反重力额度' }
}

async function showAntigravityHelp() {
  const cmd = settings.antigravityQuotaCommand || antigravity.DEFAULT_COMMAND
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '反重力（Antigravity）额度来源',
    message: '暂时读不到反重力额度',
    detail:
      `Whale Usage 会直接读取反重力 2.0 自带的本地额度接口（language_server.exe），\n` +
      `包括每周限额和 5 小时限额，不需要安装任何第三方 CLI。\n\n` +
      `请先确认反重力正在运行；如果刚启动，点「重新检测」即可。\n\n` +
      `备用方式 1（可选）：安装社区 CLI 后会把 \n  ${cmd}\n  作为兜底来源。\n` +
      `备用方式 2：也可以由你自己的脚本向以下文件写入标准 JSON：\n  ${antigravity.usagePath()}\n\n` +
      `如需修改外部命令，可编辑 settings.json 中的 antigravityQuotaCommand。`,
    buttons: ['重新检测', '打开配置文件夹', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0) antigravity.refreshNow()
  if (response === 1) shell.openPath(app.getPath('userData'))
}

async function confirmLogout() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '从 claude.ai 读取额度',
    message: '退出 claude.ai 登录？',
    detail: '退出后额度只来自 Claude Code 插件，普通聊天和 Cowork 用掉的额度要等下次在 Claude Code 里收到回复时才更新。',
    buttons: ['退出登录', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (response === 0) webusage.logout()
}

function sendConfig() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('config', { skinUrl: pathToFileURL(skinPath()).href, sound: settings.sound })
}

// Each character has an icon file with every size Windows asks for (16 to 256 px); the small ones show
// only the face, so the tray picks the size for the display scale instead of shrinking a big picture.
// The exe's own icon is icon-smile.ico (package.json); a custom picture uses that one too.
const iconFile = id => path.join(__dirname, '..', 'assets', `icon-${id}.ico`)
const APP_ICON = iconFile('smile')

function trayIcon() {
  const file = iconFile(settings.skin)
  return nativeImage.createFromPath(fs.existsSync(file) ? file : APP_ICON)
}

// The tray tooltip follows a running update and the currently followed host.
function rebuildTray() {
  const hostText = activeHost === 'antigravity' ? 'Antigravity 额度' : 'Claude 额度'
  tray.setToolTip(updateProgress ? `Whale Usage：${updateProgress}` : `Whale Usage：${hostText}`)
}

function setSetting(key, value) {
  settings[key] = value
  saveSettings()
}

function setTarget(target) {
  setSetting('target', target)
  cachedTarget = null
  if (target === 'claude' || target === 'antigravity') setActiveHost(target)
  lastBounds = null
}

function setAntigravityGroup(groupId) {
  setSetting('antigravityGroupOverride', groupId || 'auto')
  sendUsage()
}

// The right-click menu, for the tray icon and the character. Icons are Segoe Fluent Icons code points.
function openMenu(at) {
  const autoStart = app.getLoginItemSettings().openAtLogin
  const skins = SKINS.map(s => ({ id: `skin:${s.id}`, text: s.name, selected: settings.skin === s.id }))
  if (settings.customSkin) skins.push({ id: 'skin:custom', text: '自定义', selected: settings.skin === 'custom' })

  const showAntigravitySection = settings.target !== 'claude'
  const agGroups = lastAntigravityPayload?.groups || []
  const agGroupChips =
    showAntigravitySection && agGroups.length > 1
      ? [
          {
            type: 'chips',
            icon: 'E8F1',
            text: '反重力分组',
            chips: [
              { id: 'ag:group:auto', text: '自动', selected: (settings.antigravityGroupOverride || 'auto') === 'auto' },
              ...agGroups.slice(0, 4).map(g => ({
                id: `ag:group:${g.id}`,
                text: g.shortLabel || g.label,
                selected: settings.antigravityGroupOverride === g.id,
              })),
            ],
          },
        ]
      : []

  const entries = [
    { type: 'header', icon: 'E9D9', text: `Whale Usage v${app.getVersion()}` },
    ...(updateProgress
      ? [{ type: 'item', id: 'none', icon: 'E896', text: updateProgress, enabled: false }]
      : pendingUpdate
        ? [{ type: 'item', id: 'update', icon: 'E896', text: `更新到 v${pendingUpdate.version}…` }]
        : []),
    { type: 'separator' },
    { type: 'item', id: 'bubble', icon: 'E8BD', text: '显示额度气泡' },
    {
      type: 'chips',
      icon: 'E737',
      text: '跟随',
      chips: TARGETS.map(t => ({ id: `target:${t.id}`, text: t.label, selected: settings.target === t.id })),
    },
    { type: 'item', id: 'show:front', icon: 'E7F4', text: '只在目标窗口在前台时显示', checked: settings.showWhen === 'front' },
    { type: 'item', id: 'show:open', icon: 'E8A7', text: '目标窗口没最小化就一直显示', checked: settings.showWhen === 'open' },
    { type: 'separator' },
    {
      type: 'chips',
      icon: 'E71E',
      text: '大小',
      chips: SIZES.map(size => ({ id: `size:${size.scale}`, text: size.label, selected: Math.abs(settings.scale - size.scale) < 0.001 })),
    },
    { type: 'chips', icon: 'E77B', text: '形象', chips: skins },
    { type: 'item', id: 'skin:pick', icon: 'EB9F', text: '用自己的图片…' },
    { type: 'item', id: 'snap', icon: 'E718', text: '贴着输入框', checked: settings.snapToBox },
    { type: 'item', id: 'reset', icon: 'E7A7', text: '重置位置' },
    ...(settings.target !== 'antigravity'
      ? [{ type: 'item', id: 'banner', icon: 'E711', text: '自动关掉 Claude 每周限额提醒', checked: settings.closeLimitBanner }]
      : []),
    { type: 'separator' },
    ...(settings.target !== 'antigravity' ? [webUsageEntry()] : []),
    ...(showAntigravitySection ? [antigravityQuotaEntry(), ...agGroupChips] : []),
    { type: 'separator' },
    { type: 'item', id: 'notify:wait', icon: 'EA8F', text: '等我回答或批准时提醒', checked: settings.notifyWait },
    { type: 'item', id: 'notify:turn', icon: 'E930', text: '每轮结束提示用了多少额度', checked: settings.notifyTurn },
    { type: 'item', id: 'sound', icon: 'E767', text: '音效', checked: settings.sound },
    { type: 'item', id: 'autostart', icon: 'E7E8', text: '开机自启', checked: autoStart },
    { type: 'item', id: 'autoupdate', icon: 'E895', text: '自动更新', checked: settings.autoUpdate },
    { type: 'item', id: 'check', icon: 'E72C', text: '检查更新', enabled: !updateProgress },
    { type: 'separator' },
    { type: 'item', id: 'data', icon: 'E838', text: activeHost === 'antigravity' ? '打开反重力数据文件夹' : '打开 Claude 数据文件夹' },
    { type: 'item', id: 'logs', icon: 'E8A5', text: '打开日志文件夹' },
    { type: 'separator' },
    { type: 'item', id: 'quit', icon: 'E8BB', text: '退出' },
  ]

  const handlers = {
    update: () => promptUpdate(pendingUpdate),
    bubble: () => win.webContents.send('show-bubble'),
    'show:front': () => setSetting('showWhen', 'front'),
    'show:open': () => setSetting('showWhen', 'open'),
    'skin:pick': chooseSkin,
    snap: () => {
      setSetting('snapToBox', !settings.snapToBox)
      if (!settings.snapToBox && !settings.closeLimitBanner && activeHost !== 'antigravity') composer.stop()
      lastBounds = null
    },
    banner: () => {
      setSetting('closeLimitBanner', !settings.closeLimitBanner)
      if (!settings.snapToBox && !settings.closeLimitBanner && activeHost !== 'antigravity') composer.stop()
    },
    reset: () => {
      settings.hostAnchors[activeHost] = DEFAULT_HOST_ANCHOR()
      if (activeHost === 'claude') {
        settings.anchor = { ...DEFAULTS.anchor }
        settings.boxAnchor = { ...DEFAULTS.boxAnchor }
      }
      saveSettings()
      lastBounds = null
    },
    sound: () => {
      setSetting('sound', !settings.sound)
      sendConfig()
    },
    'notify:wait': () => {
      setSetting('notifyWait', !settings.notifyWait)
      scanSessions()
    },
    'notify:turn': () => setSetting('notifyTurn', !settings.notifyTurn),
    'web:login': () => webusage.login(),
    'web:logout': confirmLogout,
    'ag:refresh': () => antigravity.refreshNow(),
    'ag:login': () => antigravity.login(url => shell.openExternal(url)),
    'ag:logout': () => antigravity.logout(),
    'ag:help': showAntigravityHelp,
    'ag:toggle': () => {
      setSetting('antigravityQuotaEnabled', !settings.antigravityQuotaEnabled)
      antigravity.configure(
        {
          cmd: settings.antigravityQuotaCommand,
          intervalSec: settings.antigravityQuotaIntervalSec,
          isEnabled: settings.antigravityQuotaEnabled,
        },
        { runImmediately: settings.antigravityQuotaEnabled },
      )
    },
    'ag:group:auto': () => setAntigravityGroup('auto'),
    autostart: () => app.setLoginItemSettings({ openAtLogin: !autoStart }),
    autoupdate: () => setSetting('autoUpdate', !settings.autoUpdate),
    check: () => checkUpdates({ manual: true }),
    data: () => shell.openPath(activeHost === 'antigravity' ? antigravity.whaleDir() : path.dirname(usagePath())),
    logs: () => shell.openPath(log.dir()),
    quit: () => app.quit(),
  }
  for (const t of TARGETS) handlers[`target:${t.id}`] = () => setTarget(t.id)
  for (const size of SIZES) handlers[`size:${size.scale}`] = () => setScale(size.scale)
  for (const skin of skins) handlers[skin.id] = () => useSkin(skin.id.slice('skin:'.length))
  for (const g of agGroups) handlers[`ag:group:${g.id}`] = () => setAntigravityGroup(g.id)

  menu.show(entries, handlers, at)
}

function useSkin(id) {
  setSetting('skin', id)
  applySkin()
}

// Resizes around the character's bottom-right corner, which stays put.
function setScale(scale) {
  settings.scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)) * 100) / 100
  saveSettings()
  win.webContents.setZoomFactor(settings.scale)
  lastBounds = null
  rebuildTray()
}

function applySkin() {
  sendConfig()
  tray.setImage(trayIcon())
}

async function chooseSkin() {
  const result = await dialog.showOpenDialog({
    title: '选择形象图片（建议正方形、透明背景）',
    filters: [{ name: '图片', extensions: ['png', 'gif', 'webp', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths[0]) return
  const source = result.filePaths[0]
  const target = path.join(app.getPath('userData'), 'skins', 'custom' + path.extname(source).toLowerCase())
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  settings.customSkin = target
  useSkin('custom')
}

// ---------- updates ----------

// The Chinese half of the release notes, without the download section, as plain text.
function notesForDialog(notes) {
  const chinese = notes.split(/\n-{3,}\n/)[0].split(/###\s*下载/)[0]
  const text = chinese
    .replace(/^#+\s*/gm, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

async function checkUpdates({ manual = false } = {}) {
  if (updateProgress) return
  let update
  try {
    update = await updater.checkForUpdate()
  } catch (err) {
    log.error('update check failed', err)
    if (manual) dialog.showErrorBox('检查更新失败', `${err.message}\n\n可以到发布页手动下载：${updater.RELEASES_URL}`)
    return
  }
  pendingUpdate = update
  rebuildTray()
  if (!update) {
    if (manual) {
      dialog.showMessageBox({ type: 'info', title: '检查更新', message: `已经是最新版本（v${app.getVersion()}）` })
    }
    return
  }
  // The portable exe updates itself right away; a run from source can only point at the release page.
  if (!process.env.PORTABLE_EXECUTABLE_FILE) {
    if (manual) promptUpdate(update)
    return
  }
  installNow(update, { manual })
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: APP_ICON }).show()
}

// Downloads the new release, then the app quits, the exe is replaced and started again (a few seconds).
async function installNow(update, { manual = false } = {}) {
  if (updateProgress) return
  const setProgress = text => {
    updateProgress = text
    rebuildTray()
  }
  log.info(`updating to ${update.version}`, manual ? '(asked)' : '(automatic)')
  notify('Whale Usage 正在更新', `下载 v${update.version}，完成后会自动重启`)
  try {
    setProgress('正在下载更新…')
    let lastPercent = -1
    await updater.installUpdate(update, (done, total) => {
      if (!total) return
      const percent = Math.floor((done / total) * 100)
      if (percent !== lastPercent && percent % 5 === 0) {
        lastPercent = percent
        setProgress(`正在下载更新 ${percent}%`)
      }
    })
  } catch (err) {
    log.error('update failed', err)
    setProgress(null)
    if (manual) dialog.showErrorBox('更新失败', `${err.message}\n\n可以到发布页手动下载：${update.pageUrl}`)
    else notify('Whale Usage 自动更新失败', '可以在右键菜单里点「检查更新」再试一次')
  }
}

// For a run from source (no exe to replace), or the menu's update row after a failed update
async function promptUpdate(update) {
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `Whale Usage v${update.version}`,
    detail: `当前版本 v${app.getVersion()}\n\n${notesForDialog(update.notes)}`,
    buttons: portable ? ['下载并更新', '查看发布页', '以后再说'] : ['查看发布页', '以后再说'],
    defaultId: 0,
    cancelId: portable ? 2 : 1,
    noLink: true,
  })
  const choice = portable ? response : response + 1
  if (choice === 0) installNow(update, { manual: true })
  if (choice === 1) shell.openExternal(update.pageUrl)
}

function scheduleUpdateChecks() {
  const run = () => settings.autoUpdate && checkUpdates()
  setTimeout(run, UPDATE_FIRST_CHECK_MS)
  setInterval(run, UPDATE_INTERVAL_MS)
}

function watchUsage() {
  const claudeFile = usagePath()
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true })
  fs.watchFile(claudeFile, { interval: 1500 }, () => {
    if (activeHost === 'claude') sendUsage()
  })

  const agUsageFile = antigravity.usagePath()
  const agStateFile = antigravity.statePath()
  fs.mkdirSync(path.dirname(agUsageFile), { recursive: true })
  fs.watchFile(agUsageFile, { interval: 1500 }, () => {
    if (activeHost === 'antigravity') sendUsage()
  })
  fs.watchFile(agStateFile, { interval: 1000 }, () => {
    if (activeHost === 'antigravity') sendUsage()
  })
}

// Session states from Claude & Antigravity plugins: open waits keep a bubble up, new ones and finished turns chime.
const sessionTracker = sessions.createTracker()

function readAllSessions() {
  const claudeList = sessions.read(sessionsDir()).map(s => ({ ...s, host: s.host || 'claude' }))
  const agList = sessions.read(antigravity.sessionsDir()).map(s => ({ ...s, host: s.host || 'antigravity' }))
  return [...claudeList, ...agList]
}

function scanSessions() {
  if (!win || win.isDestroyed()) return
  const { active, newWaits, newTurns, completedTurns } = sessions.track(sessionTracker, readAllSessions())
  for (const wait of newWaits) log.info('session waiting', wait.host, wait.session, wait.kind, wait.tool)
  for (const turn of newTurns) log.info('turn finished', turn.host, turn.session, JSON.stringify(turn.deltas))
  if (completedTurns.some(t => t.host === 'antigravity')) antigravity.refreshNow()
  win.webContents.send('waits', { active: settings.notifyWait ? active : [], fresh: settings.notifyWait && newWaits.length > 0 })
  if (settings.notifyTurn && newTurns.length > 0) win.webContents.send('turn', newTurns[newTurns.length - 1])
}

function watchSessionDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  try {
    sessions.removeOld(dir)
  } catch (err) {
    log.warn('could not clean old session files', err.message)
  }
  let soon = null
  try {
    fs.watch(dir, () => {
      soon ??= setTimeout(() => {
        soon = null
        scanSessions()
      }, 120)
    })
  } catch (err) {
    log.warn('could not watch the sessions folder, polling only', err.message)
  }
}

function watchSessions() {
  watchSessionDir(sessionsDir())
  watchSessionDir(antigravity.sessionsDir())
  // Also look every few seconds, in case a change notice is missed and so stale waits expire
  setInterval(scanSessions, 3000)
}

function createWindow() {
  const d = dims()
  win = new BrowserWindow({
    width: d.w,
    height: d.h,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Reminder sounds must play while the window is hidden (host app not in front)
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(settings.scale)
    sendConfig()
    sendUsage()
    scanSessions()
    if (process.env.WHALE_FORCE_SHOW === '1') setTimeout(() => win.webContents.send('show-bubble'), 800)
  })
}

ipcMain.on('mouse-over-pet', (_e, over) => {
  if (!dragging) win.setIgnoreMouseEvents(!over, { forward: true })
})

ipcMain.on('drag-start', () => {
  const [x, y] = win.getPosition()
  const cursor = screen.getCursorScreenPoint()
  dragging = { x, y, cx: cursor.x, cy: cursor.y }
})

ipcMain.on('drag-move', () => {
  if (!dragging) return
  const cursor = screen.getCursorScreenPoint()
  const d = dims()
  win.setBounds({
    x: dragging.x + cursor.x - dragging.cx,
    y: dragging.y + cursor.y - dragging.cy,
    width: d.w,
    height: d.h,
  })
})

ipcMain.on('open-menu', () => openMenu())

ipcMain.on('resize-step', (_e, direction) => setScale(settings.scale + direction * 0.05))

ipcMain.on('select-group', (_e, groupId) => setAntigravityGroup(groupId))

ipcMain.on('drag-end', () => {
  if (!dragging) return
  if (lastHostRect) {
    const updated = anchorFromDrop(win.getBounds())
    Object.assign(anchorOf(activeHost), updated)
    if (activeHost === 'claude') Object.assign(settings, updated)
    saveSettings()
  }
  dragging = null
  lastBounds = null
})

// For trying a build next to the running one: its own settings, log and single-instance lock
if (process.env.WHALE_USER_DATA) app.setPath('userData', process.env.WHALE_USER_DATA)

const finishing = updater.finishTarget()
if (finishing) {
  // This is the new exe of an update, started only to put itself in place of the old one
  app.whenReady().then(async () => {
    log.init(path.join(app.getPath('userData'), 'logs'))
    log.info(`finishing the update to v${app.getVersion()}`)
    await updater.finishUpdate(finishing)
    app.exit(0)
  })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(() => {
    log.init(path.join(app.getPath('userData'), 'logs'))
    log.info(
      `start v${app.getVersion()}`,
      process.env.PORTABLE_EXECUTABLE_FILE ? `portable ${process.env.PORTABLE_EXECUTABLE_FILE}` : 'installed',
      `claude usage ${usagePath()}`,
      `antigravity usage ${antigravity.usagePath()}`,
    )
    process.on('uncaughtException', err => log.error('uncaught', err))
    loadSettings()
    updater.cleanUpAfterUpdate()
    createWindow()
    tray = new Tray(trayIcon())
    tray.setToolTip('Whale Usage：订阅额度')
    tray.on('click', () => win.webContents.send('show-bubble'))
    tray.on('right-click', () => openMenu())
    rebuildTray()
    watchUsage()
    webusage.start(() => {
      if (activeHost === 'claude') sendUsage()
    })
    antigravity.start(
      () => {
        if (activeHost === 'antigravity') sendUsage()
      },
      {
        cmd: settings.antigravityQuotaCommand,
        intervalSec: settings.antigravityQuotaIntervalSec,
        isEnabled: settings.antigravityQuotaEnabled,
      },
    )
    watchSessions()
    setInterval(tick, TICK_MS)
    scheduleUpdateChecks()
  })
  app.on('will-quit', () => {
    composer.stop()
    antigravity.stop()
    log.info('quit')
  })
  app.on('window-all-closed', e => e.preventDefault())
}
