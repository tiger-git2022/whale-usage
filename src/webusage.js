// Reads the account's usage straight from claude.ai, so conversations outside Claude Code (Chat,
// Cowork, the web, the phone) count too. The widget keeps its own claude.ai sign-in in its own
// browser storage: the person signs in once in a window it opens, and it asks
// GET /api/organizations/<id>/usage every minute while signed in. Nothing is copied from the Claude
// app, and no password passes through the widget's code: the sign-in is claude.ai's own page.

const { BrowserWindow, session } = require('electron')
const log = require('./log')
const { fromWeb } = require('./limits')

const BASE = 'https://claude.ai'
const PARTITION = 'persist:claude-ai'
const POLL_MS = 60 * 1000
const RETRY_MS = 5 * 60 * 1000 // after an error that is not a signed-out answer

let state = 'unknown' // 'signed-in', 'signed-out', 'error' or 'unknown' (not asked yet)
let latest = null // { at, limits } from the last good answer
let orgId = null
let timer = null
let loginWin = null
let onChange = () => {}
let lastError = null

const ses = () => session.fromPartition(PARTITION)

// claude.ai may turn away a client that names itself Electron; this is the same Chromium without that
function chromeUserAgent() {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
}

class SignedOut extends Error {}

async function getJson(path) {
  const res = await ses().fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, credentials: 'include' })
  if (res.status === 401 || res.status === 403) {
    const text = await res.text()
    // A Cloudflare check page is not a signed-out answer
    if (/permission_error|authentication_error|account_session_invalid|Invalid authorization/i.test(text) || res.status === 401) {
      throw new SignedOut(`${res.status}`)
    }
    throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// The organization the person last used on claude.ai, or the first one that can chat
async function findOrg() {
  const orgs = await getJson('/api/organizations')
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('no organizations')
  const [last] = await ses().cookies.get({ url: BASE, name: 'lastActiveOrg' })
  const chosen =
    orgs.find(o => last && o.uuid === last.value) ??
    orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) ??
    orgs[0]
  return chosen.uuid
}

function setState(next) {
  if (next === state) return
  state = next
  log.info('claude.ai usage:', state)
}

async function refresh() {
  clearTimeout(timer)
  try {
    orgId ??= await findOrg()
    const limits = fromWeb(await getJson(`/api/organizations/${orgId}/usage`))
    latest = { at: Date.now(), limits }
    lastError = null
    setState('signed-in')
    onChange()
    timer = setTimeout(refresh, POLL_MS)
  } catch (err) {
    orgId = null
    if (err instanceof SignedOut) {
      latest = null
      setState('signed-out')
      onChange()
      return // until the person signs in again
    }
    if (err.message !== lastError) log.warn('claude.ai usage failed:', err.message)
    lastError = err.message
    setState('error')
    timer = setTimeout(refresh, RETRY_MS)
  }
}

// Starts asking if a sign-in is kept from before; a widget never signed in stays quiet
async function start(changed) {
  onChange = changed
  ses().setUserAgent(chromeUserAgent())
  const cookies = await ses().cookies.get({ url: BASE })
  if (cookies.length === 0) {
    state = 'signed-out'
    return
  }
  refresh()
}

// claude.ai's own sign-in page in a window; it closes once the account answers
function login() {
  if (loginWin && !loginWin.isDestroyed()) return loginWin.focus()
  loginWin = new BrowserWindow({
    width: 480,
    height: 720,
    title: '登录 claude.ai（Whale Usage 读取额度用）',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  })
  const win = loginWin
  // Sign-in with Google and the like opens a popup; it shares this window's storage
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }))
  let checking = false
  const check = async (_e, url) => {
    if (checking || win.isDestroyed() || /\/(login|magic-link|oauth|sso)/.test(new URL(url).pathname)) return
    checking = true
    try {
      orgId = await findOrg()
      log.info('signed in to claude.ai')
      win.close()
      refresh()
    } catch {
      // Not signed in yet
    } finally {
      checking = false
    }
  }
  win.webContents.on('did-navigate', check)
  win.webContents.on('did-navigate-in-page', check)
  win.on('closed', () => {
    if (loginWin === win) loginWin = null
  })
  win.loadURL(`${BASE}/login`)
}

async function logout() {
  clearTimeout(timer)
  await ses().clearStorageData()
  orgId = null
  latest = null
  log.info('signed out of claude.ai')
  setState('signed-out')
  onChange()
}

module.exports = {
  start,
  login,
  logout,
  refresh,
  state: () => state,
  latest: () => latest,
}
