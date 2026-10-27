const { app, BrowserWindow, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const log = require('./log')
const menu = require('./menu')
const sessions = require('./sessions')
const updater = require('./updater')
const { claudeState } = require('./win32')

// The widget window at 100% size: the character sits at its bottom-right, the bubble above it.
// The page is zoomed by settings.scale, so these all scale together.
const BASE = { w: 300, h: 300, inset: 6, pet: 108 }
const SCALE_MIN = 0.4
const SCALE_MAX = 1.2
const SIZES = [
  { label: '小', scale: 0.5 },
  { label: '中', scale: 0.7 },
  { label: '大', scale: 0.9 },
  { label: '特大', scale: 1.1 },
]
const TICK_MS = 80
const UPDATE_FIRST_CHECK_MS = 15 * 1000
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const SNAP_DIP = 28

const DEFAULTS = {
  // Where the character's bottom-right corner sits, measured from Claude's bottom-right corner.
  // The default peeks in from Claude's right edge, just above the input box. The art is cropped
  // on its right side, so that edge sits flush with the window (the screen edge when maximized).
  anchor: { dx: 0, dy: -100 },
  scale: 0.7,
  showWhen: 'front', // 'front': only while Claude is the active window; 'open': whenever Claude is not minimized
  sound: true,
  notifyWait: true, // bubble and sound when a session waits for an answer or an approval
  notifyTurn: true, // bubble and sound when a turn ends having used at least 1% of a window
  skin: 'peek', // one of SKINS, or 'custom' for customSkin
  customSkin: null, // a picture the person chose, copied into the app's data folder
  autoUpdate: true, // look for a new release at start and every few hours, and install it right away
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
let cachedClaude = null
let dragging = null
let lastBounds = null
let isShown = false
let lastClaudeRect = null
let claudeSeen = null // for logging when Claude's window appears or goes
let pendingUpdate = null // the newer release found by the last check
let updateProgress = null // text while an update downloads

function loadSettings() {
  try {
    // Notepad and PowerShell may save the file with a byte order mark
    const text = fs.readFileSync(settingsPath(), 'utf8').replace(/^﻿/, '')
    settings = { ...DEFAULTS, ...JSON.parse(text) }
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('settings unreadable, using defaults:', err.message)
    settings = { ...DEFAULTS }
  }
  // Before there were several characters, skin held the custom picture's path, or null
  if (settings.skin === null) settings.skin = DEFAULTS.skin
  if (settings.skin !== 'custom' && !SKINS.some(s => s.id === settings.skin)) {
    settings.customSkin = settings.skin
    settings.skin = 'custom'
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
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

// Window position for a given Claude rectangle (DIP) and the saved anchor.
function boundsFor(claude) {
  const d = dims()
  const petRight = claude.x + claude.width + settings.anchor.dx
  const petBottom = claude.y + claude.height + settings.anchor.dy
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

function tick() {
  if (!win || win.isDestroyed()) return
  let state
  try {
    state = claudeState(cachedClaude, process.pid)
  } catch (err) {
    log.error('claude window lookup failed', err)
    return
  }
  cachedClaude = state.window
  const seen = state.window ? state.window.hwnd : 0
  if (seen !== claudeSeen) {
    log.info(seen ? `following Claude window ${seen} (pid ${state.window.pid})` : 'no Claude window')
    claudeSeen = seen
  }
  if (!state.window || state.minimized) return setShown(false)

  const claude = toDip(state.rect)
  if (!dragging) {
    const b = boundsFor(claude)
    if (!lastBounds || b.x !== lastBounds.x || b.y !== lastBounds.y || b.width !== lastBounds.width) {
      win.setBounds(b)
      lastBounds = b
    }
  }
  lastClaudeRect = claude

  const inFront = state.claudeInFront || state.selfInFront || dragging
  setShown(settings.showWhen === 'open' || process.env.WHALE_FORCE_SHOW === '1' ? true : inFront)
}

// Snaps the character flush to Claude's left or right edge when dropped close to it.
function anchorFromDrop(bounds) {
  const c = lastClaudeRect
  const d = dims()
  let petRight = bounds.x + d.w - d.inset
  const petBottom = bounds.y + d.h - d.inset
  const right = c.x + c.width
  if (Math.abs(petRight - right) < SNAP_DIP) petRight = right
  if (Math.abs(petRight - d.pet - c.x) < SNAP_DIP) petRight = c.x + d.pet
  return { dx: Math.round(petRight - right), dy: Math.round(petBottom - (c.y + c.height)) }
}

function sendUsage() {
  if (!win || win.isDestroyed()) return
  let usage = null
  try {
    usage = JSON.parse(fs.readFileSync(usagePath(), 'utf8'))
    log.info('usage', (usage.limits || []).map(l => `${l.kind} ${l.percentUsed}%`).join(', '))
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('could not read usage file', err.message)
  }
  win.webContents.send('usage', usage)
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

// The tray tooltip follows a running update; the menu itself is built each time it opens.
function rebuildTray() {
  tray.setToolTip(updateProgress ? `Whale Usage：${updateProgress}` : 'Whale Usage：Claude 额度')
}

function setSetting(key, value) {
  settings[key] = value
  saveSettings()
}

// The right-click menu, for the tray icon and the character. Icons are Segoe Fluent Icons code points.
function openMenu(at) {
  const autoStart = app.getLoginItemSettings().openAtLogin
  const skins = SKINS.map(s => ({ id: `skin:${s.id}`, text: s.name, selected: settings.skin === s.id }))
  if (settings.customSkin) skins.push({ id: 'skin:custom', text: '自定义', selected: settings.skin === 'custom' })

  const entries = [
    { type: 'header', icon: 'E9D9', text: `Whale Usage v${app.getVersion()}` },
    ...(updateProgress
      ? [{ type: 'item', id: 'none', icon: 'E896', text: updateProgress, enabled: false }]
      : pendingUpdate
        ? [{ type: 'item', id: 'update', icon: 'E896', text: `更新到 v${pendingUpdate.version}…` }]
        : []),
    { type: 'separator' },
    { type: 'item', id: 'bubble', icon: 'E8BD', text: '显示额度气泡' },
    { type: 'item', id: 'show:front', icon: 'E7F4', text: '只在 Claude 是当前窗口时显示', checked: settings.showWhen === 'front' },
    { type: 'item', id: 'show:open', icon: 'E8A7', text: 'Claude 没最小化就一直显示', checked: settings.showWhen === 'open' },
    { type: 'separator' },
    {
      type: 'chips',
      icon: 'E71E',
      text: '大小',
      chips: SIZES.map(size => ({ id: `size:${size.scale}`, text: size.label, selected: Math.abs(settings.scale - size.scale) < 0.001 })),
    },
    { type: 'chips', icon: 'E77B', text: '形象', chips: skins },
    { type: 'item', id: 'skin:pick', icon: 'EB9F', text: '用自己的图片…' },
    { type: 'item', id: 'reset', icon: 'E7A7', text: '重置位置' },
    { type: 'separator' },
    { type: 'item', id: 'notify:wait', icon: 'EA8F', text: '等我回答或批准时提醒', checked: settings.notifyWait },
    { type: 'item', id: 'notify:turn', icon: 'E930', text: '每轮结束提示用了多少额度', checked: settings.notifyTurn },
    { type: 'item', id: 'sound', icon: 'E767', text: '音效', checked: settings.sound },
    { type: 'item', id: 'autostart', icon: 'E7E8', text: '开机自启', checked: autoStart },
    { type: 'item', id: 'autoupdate', icon: 'E895', text: '自动更新', checked: settings.autoUpdate },
    { type: 'item', id: 'check', icon: 'E72C', text: '检查更新', enabled: !updateProgress },
    { type: 'separator' },
    { type: 'item', id: 'data', icon: 'E838', text: '打开额度数据文件夹' },
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
    reset: () => {
      setSetting('anchor', { ...DEFAULTS.anchor })
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
    autostart: () => app.setLoginItemSettings({ openAtLogin: !autoStart }),
    autoupdate: () => setSetting('autoUpdate', !settings.autoUpdate),
    check: () => checkUpdates({ manual: true }),
    data: () => shell.openPath(path.dirname(usagePath())),
    logs: () => shell.openPath(log.dir()),
    quit: () => app.quit(),
  }
  for (const size of SIZES) handlers[`size:${size.scale}`] = () => setScale(size.scale)
  for (const skin of skins) handlers[skin.id] = () => useSkin(skin.id.slice('skin:'.length))

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
  const file = usagePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.watchFile(file, { interval: 1500 }, sendUsage)
}

// Session states from the plugin: open waits keep a bubble up, new ones and finished turns also make a sound.
const sessionTracker = sessions.createTracker()

function scanSessions() {
  if (!win || win.isDestroyed()) return
  const { active, newWaits, newTurns } = sessions.track(sessionTracker, sessions.read(sessionsDir()))
  for (const wait of newWaits) log.info('session waiting', wait.session, wait.kind, wait.tool)
  for (const turn of newTurns) log.info('turn finished', turn.session, JSON.stringify(turn.deltas))
  win.webContents.send('waits', { active: settings.notifyWait ? active : [], fresh: settings.notifyWait && newWaits.length > 0 })
  if (settings.notifyTurn && newTurns.length > 0) win.webContents.send('turn', newTurns[newTurns.length - 1].deltas)
}

function watchSessions() {
  const dir = sessionsDir()
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
      // Reminder sounds must play while the window is hidden (Claude not in front)
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

ipcMain.on('drag-end', () => {
  if (!dragging) return
  if (lastClaudeRect) {
    settings.anchor = anchorFromDrop(win.getBounds())
    saveSettings()
  }
  dragging = null
  lastBounds = null
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(() => {
    log.init(path.join(app.getPath('userData'), 'logs'))
    log.info(`start v${app.getVersion()}`, process.env.PORTABLE_EXECUTABLE_FILE ? `portable ${process.env.PORTABLE_EXECUTABLE_FILE}` : 'installed', `usage file ${usagePath()}`)
    process.on('uncaughtException', err => log.error('uncaught', err))
    loadSettings()
    updater.cleanUpAfterUpdate()
    createWindow()
    tray = new Tray(trayIcon())
    tray.setToolTip('Whale Usage：Claude 额度')
    tray.on('click', () => win.webContents.send('show-bubble'))
    tray.on('right-click', () => openMenu())
    rebuildTray()
    watchUsage()
    watchSessions()
    setInterval(tick, TICK_MS)
    scheduleUpdateChecks()
  })
  app.on('will-quit', () => log.info('quit'))
  app.on('window-all-closed', e => e.preventDefault())
}
