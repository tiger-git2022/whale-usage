// Finds the Claude desktop app's main window and reads its position and state.
// Uses plain Win32 calls through koffi, so no native module has to be compiled.

const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const dwmapi = koffi.load('dwmapi.dll')

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })

const FindWindowExW = user32.func('intptr __stdcall FindWindowExW(intptr parent, intptr after, str16 cls, str16 title)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)')
const IsWindow = user32.func('bool __stdcall IsWindow(intptr hwnd)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)')
const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)')
const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)')
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()')
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr hwnd)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hwnd, void *buf, int max)')

const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr proc, uint32 flags, void *buf, _Inout_ uint32 *size)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr h)')

const DwmGetWindowAttributeRect = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ RECT *value, uint32 size)')
const DwmGetWindowAttributeInt = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ int32 *value, uint32 size)')

const GW_OWNER = 4
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14

const exeNameCache = new Map()

function processIdOf(hwnd) {
  const pid = [0]
  GetWindowThreadProcessId(hwnd, pid)
  return pid[0]
}

function exePathOf(pid) {
  if (exeNameCache.has(pid)) return exeNameCache.get(pid)
  let exePath = ''
  const proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (proc) {
    const buf = Buffer.alloc(1024 * 2)
    const size = [1024]
    if (QueryFullProcessImageNameW(proc, 0, buf, size)) exePath = buf.toString('utf16le', 0, size[0] * 2)
    CloseHandle(proc)
  }
  exeNameCache.set(pid, exePath)
  return exePath
}

// The Claude desktop app is an Electron app named Claude.exe. The Claude Code CLI is
// also claude.exe but has no window of this class, so the class filter keeps it out.
function isClaudeApp(pid) {
  const exePath = exePathOf(pid).toLowerCase()
  return exePath.endsWith('\\claude.exe') && !exePath.includes('\\.local\\bin\\')
}

function isCloaked(hwnd) {
  const value = [0]
  return DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, value, 4) === 0 && value[0] !== 0
}

function frameRect(hwnd) {
  const rect = {}
  if (DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) === 0) return rect
  GetWindowRect(hwnd, rect)
  return rect
}

function className(hwnd) {
  const buf = Buffer.alloc(256 * 2)
  const n = GetClassNameW(hwnd, buf, 256)
  return buf.toString('utf16le', 0, n * 2)
}

// A visible, unowned, titled Claude app window: a chat window, not a popup or menu.
function asClaudeWindow(hwnd) {
  if (!hwnd || !IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) || GetWindowTextLengthW(hwnd) === 0) return null
  if (className(hwnd) !== 'Chrome_WidgetWin_1') return null
  const pid = processIdOf(hwnd)
  return isClaudeApp(pid) ? { hwnd, pid } : null
}

// The largest Claude window, for when none is in front.
function findClaudeWindow() {
  let best = null
  let bestArea = 0
  let hwnd = 0
  for (let i = 0; i < 500; i++) {
    hwnd = FindWindowExW(0, hwnd, 'Chrome_WidgetWin_1', null)
    if (!hwnd) break
    const candidate = asClaudeWindow(hwnd)
    if (!candidate) continue
    const r = frameRect(hwnd)
    const area = (r.right - r.left) * (r.bottom - r.top)
    if (area > bestArea) {
      best = candidate
      bestArea = area
    }
  }
  return best
}

// What the widget needs each tick: which Claude window to sit on, where it is, and whether
// it is on screen and in front. With several Claude windows, the one in front wins.
function claudeState(cached, ownPid) {
  const foreground = GetForegroundWindow()
  const foregroundPid = foreground ? processIdOf(foreground) : 0
  const inFront = asClaudeWindow(foreground)
  const stillThere = cached && IsWindow(cached.hwnd) && IsWindowVisible(cached.hwnd) ? cached : null
  const win = inFront ?? stillThere ?? findClaudeWindow()
  if (!win) return { window: null }
  const minimized = IsIconic(win.hwnd) || isCloaked(win.hwnd)
  return {
    window: win,
    rect: frameRect(win.hwnd),
    minimized,
    claudeInFront: foregroundPid === win.pid,
    selfInFront: foregroundPid === ownPid,
  }
}

module.exports = { claudeState, findClaudeWindow }
