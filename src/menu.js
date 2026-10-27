// The right-click menu, styled like the Claude Auto Pass tray menu (windows/src/TrayMenu.cs there): a small
// borderless window with the Windows 11 acrylic backdrop (the one Windows uses for its own menus), rounded
// corners and Fluent icons, light or dark with Windows. Windows 10 gets a plain background. It closes when it
// loses focus or on Esc, and the arrow keys move between rows like a native menu.

const { BrowserWindow, ipcMain, nativeTheme, screen, systemPreferences } = require('electron')
const os = require('os')
const path = require('path')
const log = require('./log')
const { roundCorners } = require('./win32')

// The acrylic system backdrop needs Windows 11 22H2 (build 22621)
const ACRYLIC = Number(os.release().split('.')[2]) >= 22621

let menu = null // { win, handlers, at }

function close() {
  const current = menu
  menu = null
  if (current && !current.win.isDestroyed()) current.win.close()
}

// Above and to the right of the point, flipped to stay inside the work area (all in DIP).
function place(at, width, height) {
  const area = screen.getDisplayNearestPoint(at).workArea
  let x = at.x + width <= area.x + area.width ? at.x : at.x - width
  let y = at.y - height >= area.y ? at.y - height : at.y
  x = Math.max(area.x, Math.min(x, area.x + area.width - width))
  y = Math.max(area.y, Math.min(y, area.y + area.height - height))
  return { x: Math.round(x), y: Math.round(y), width: Math.ceil(width), height: Math.ceil(height) }
}

/**
 * Opens the menu at a screen point (DIP). `entries` is a list of plain rows (see renderer/menu.js);
 * a row's `id` (or a chip's) is looked up in `handlers` when it is chosen.
 */
function show(entries, handlers, at = screen.getCursorScreenPoint()) {
  close()
  const win = new BrowserWindow({
    width: 280,
    height: 200,
    x: -32000,
    y: -32000,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    backgroundMaterial: ACRYLIC ? 'acrylic' : 'none',
    title: 'Whale Usage',
    webPreferences: {
      preload: path.join(__dirname, 'menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  menu = { win, handlers, at }
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.on('blur', () => menu?.win === win && close())
  win.on('closed', () => {
    if (menu?.win === win) menu = null
  })
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('menu-entries', {
      entries,
      dark: nativeTheme.shouldUseDarkColors,
      acrylic: ACRYLIC,
      accent: `#${systemPreferences.getAccentColor().slice(0, 6)}`,
    })
  })
  win.loadFile(path.join(__dirname, 'renderer', 'menu.html'))
}

ipcMain.on('menu-size', (e, size) => {
  if (!menu || e.sender !== menu.win.webContents) return
  const { win, at } = menu
  win.setBounds(place(at, size.width, size.height))
  if (!win.isVisible()) {
    try {
      roundCorners(win.getNativeWindowHandle())
    } catch (err) {
      log.warn('could not round the menu corners', err.message)
    }
    win.show()
    win.focus()
  }
})

ipcMain.on('menu-choose', (e, id) => {
  if (!menu || e.sender !== menu.win.webContents) return
  const handler = menu.handlers[id]
  close()
  if (!handler) return
  try {
    handler()
  } catch (err) {
    log.error('menu action failed', id, err)
  }
})

ipcMain.on('menu-close', e => {
  if (menu && e.sender === menu.win.webContents) close()
})

module.exports = { show, close }
