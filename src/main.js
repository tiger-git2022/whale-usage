const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const log = require('./log')
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
  skin: null, // absolute path to a custom image, or null for the bundled one
  autoUpdate: true, // check for a new release at start and every few hours
  skippedVersion: null, // a release the person chose to skip; a later one is offered again
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
const usagePath = () =>
  process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'whale', 'usage.json')
    : path.join(os.homedir(), '.claude', 'whale', 'usage.json')
const bundledSkin = () => path.join(__dirname, '..', 'skins', 'default', 'character.png')

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
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }
  } catch {
    settings = { ...DEFAULTS }
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

function skinPath() {
  return settings.skin && fs.existsSync(settings.skin) ? settings.skin : bundledSkin()
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

function trayIcon() {
  return nativeImage.createFromPath(skinPath()).resize({ width: 16, height: 16, quality: 'best' })
}

function rebuildTray() {
  const showWhen = value => ({
    type: 'radio',
    checked: settings.showWhen === value,
    click: () => {
      settings.showWhen = value
      saveSettings()
    },
  })
  const updateItems = updateProgress
    ? [{ label: updateProgress, enabled: false }]
    : pendingUpdate
      ? [{ label: `更新到 v${pendingUpdate.version}…`, click: () => promptUpdate(pendingUpdate) }]
      : []
  const menu = Menu.buildFromTemplate([
    { label: `Whale Usage v${app.getVersion()}`, enabled: false },
    ...updateItems,
    { type: 'separator' },
    { label: '显示额度气泡', click: () => win.webContents.send('show-bubble') },
    { type: 'separator' },
    { label: '只在 Claude 是当前窗口时显示', ...showWhen('front') },
    { label: 'Claude 没最小化就一直显示', ...showWhen('open') },
    { type: 'separator' },
    {
      label: '音效',
      type: 'checkbox',
      checked: settings.sound,
      click: item => {
        settings.sound = item.checked
        saveSettings()
        sendConfig()
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: '大小（也可以在形象上滚动滚轮）',
      submenu: SIZES.map(size => ({
        label: size.label,
        type: 'radio',
        checked: Math.abs(settings.scale - size.scale) < 0.001,
        click: () => setScale(size.scale),
      })),
    },
    { label: '更换形象…', click: chooseSkin },
    {
      label: '恢复默认形象',
      enabled: Boolean(settings.skin),
      click: () => {
        settings.skin = null
        saveSettings()
        applySkin()
      },
    },
    {
      label: '重置位置',
      click: () => {
        settings.anchor = { ...DEFAULTS.anchor }
        saveSettings()
        lastBounds = null
      },
    },
    { type: 'separator' },
    { label: '检查更新', enabled: !updateProgress, click: () => checkUpdates({ manual: true }) },
    {
      label: '自动检查更新',
      type: 'checkbox',
      checked: settings.autoUpdate,
      click: item => {
        settings.autoUpdate = item.checked
        saveSettings()
      },
    },
    { label: '打开额度数据文件夹', click: () => shell.openPath(path.dirname(usagePath())) },
    { label: '打开日志文件夹', click: () => shell.openPath(log.dir()) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
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
  rebuildTray()
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
  settings.skin = target
  saveSettings()
  applySkin()
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
  if (manual) return promptUpdate(update)
  if (settings.skippedVersion === update.version) return
  if (Notification.isSupported()) {
    const note = new Notification({ title: 'Whale Usage 有新版本', body: `v${update.version}，点这里查看更新内容` })
    note.on('click', () => promptUpdate(update))
    note.show()
  }
}

async function promptUpdate(update) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `Whale Usage v${update.version}`,
    detail: `当前版本 v${app.getVersion()}\n\n${notesForDialog(update.notes)}`,
    buttons: ['下载并更新', '查看发布页', '跳过这个版本', '以后再说'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  })
  if (response === 1) shell.openExternal(update.pageUrl)
  if (response === 2) {
    settings.skippedVersion = update.version
    saveSettings()
  }
  if (response !== 0) return

  const setProgress = text => {
    updateProgress = text
    tray.setToolTip(text ? `Whale Usage：${text}` : 'Whale Usage：Claude 额度')
    rebuildTray()
  }
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
    dialog.showErrorBox('更新失败', `${err.message}\n\n可以到发布页手动下载：${update.pageUrl}`)
  }
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
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(settings.scale)
    sendConfig()
    sendUsage()
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
    rebuildTray()
    watchUsage()
    setInterval(tick, TICK_MS)
    scheduleUpdateChecks()
  })
  app.on('will-quit', () => log.info('quit'))
  app.on('window-all-closed', e => e.preventDefault())
}
