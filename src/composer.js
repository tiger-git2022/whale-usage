// Finds the input box (the composer) in the Claude window, so the character can sit on top of it.
//
// Claude's window exposes its page through Windows UI Automation. A hidden PowerShell process reads it:
// the widget writes a window handle on a line, and it answers with the box's screen rectangle in
// physical pixels, as JSON on a line: {"x","y","w","h"}, {} when there is no box, or {"error"}.
// The box is the rounded frame around the prompt editor (a ProseMirror editor), which grows as the
// prompt gets longer. With panes side by side, it is the rightmost one, next to where the character sits.

const { spawn } = require('child_process')
const log = require('./log')

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$editCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$box = $null
$boxHwnd = 0
$searched = [DateTime]::MinValue

function Find-Box($hwnd) {
  $root = $AE::FromHandle([IntPtr]$hwnd)
  $best = $null
  foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)) {
    $c = $e.Current
    $r = $c.BoundingRectangle
    if ($c.ClassName -notlike '*ProseMirror*' -or $c.IsOffscreen -or $r.IsEmpty -or $r.Width -le 0) { continue }
    if (-not $best -or $r.Right -gt $best.Current.BoundingRectangle.Right) { $best = $e }
  }
  if (-not $best) { return $null }
  $editHeight = $best.Current.BoundingRectangle.Height
  $cur = $best
  for ($i = 0; $i -lt 8; $i++) {
    $cur = $walker.GetParent($cur)
    if (-not $cur) { break }
    $c = $cur.Current
    if ($c.ClassName -match '(^|\s)rounded' -and $c.BoundingRectangle.Height -ge $editHeight + 8) { return $cur }
  }
  return $best
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $out = '{}'
  try {
    $hwnd = [Int64]$line
    $age = ([DateTime]::UtcNow - $searched).TotalSeconds
    if ($hwnd -ne $boxHwnd -or ((-not $box) -and $age -gt 1) -or $age -gt 5) {
      $searched = [DateTime]::UtcNow
      $boxHwnd = $hwnd
      $box = Find-Box $hwnd
    }
    if ($box) {
      $c = $box.Current
      $r = $c.BoundingRectangle
      if ($c.IsOffscreen -or $r.IsEmpty -or $r.Width -le 0) { $box = $null }
      else { $out = '{"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + '}' }
    }
  } catch {
    $box = $null
    $out = '{"error":' + (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}'
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
`

const POLL_MS = 200 // how often to ask while the character follows the box
const STALL_MS = 5000 // an unanswered question this old means the reader is stuck
const RESTART_MS = 10 * 1000

let child = null
let asked = null // { hwnd, at } while a question is out
let latest = null // { hwnd, rect, at }
let lastStart = 0
let lastError = null

function start() {
  if (Date.now() - lastStart < RESTART_MS) return
  lastStart = Date.now()
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  // Not detached: windowsHide keeps it without a console window, and it ends with the widget.
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const proc = child
  log.info('input box reader started', proc.pid)
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', chunk => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      answer(buffer.slice(0, nl).trim())
      buffer = buffer.slice(nl + 1)
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', text => log.warn('input box reader:', text.trim().slice(0, 300)))
  proc.stdin.on('error', () => {})
  proc.on('error', err => log.error('input box reader failed to start', err))
  proc.on('exit', code => {
    if (child === proc) child = null
    asked = null
    latest = null
    log.info('input box reader ended', code)
  })
}

function answer(line) {
  if (!line || !asked) return
  const { hwnd } = asked
  asked = null
  let value = {}
  try {
    value = JSON.parse(line)
  } catch {
    return
  }
  if (value.error) {
    if (value.error !== lastError) log.warn('input box lookup failed:', value.error)
    lastError = value.error
  } else lastError = null
  const rect = Number.isFinite(value.x) && value.w > 0 && value.h > 0
    ? { left: value.x, top: value.y, right: value.x + value.w, bottom: value.y + value.h }
    : null
  latest = { hwnd, rect, at: Date.now() }
}

// Asks for the box of the window `hwnd`, at most every POLL_MS
function poll(hwnd) {
  const now = Date.now()
  if (asked) {
    if (now - asked.at < STALL_MS) return
    log.warn('input box reader stopped answering, restarting it')
    stop()
  }
  if (latest && latest.hwnd === hwnd && now - latest.at < POLL_MS) return
  if (!child) start()
  if (!child) return
  asked = { hwnd, at: now }
  child.stdin.write(`${hwnd}\n`)
}

// The box's last known rectangle (physical pixels: left, top, right, bottom), or null. It may be from
// before the character was last hidden; the next answer, a moment later, corrects it.
function boxOf(hwnd) {
  if (!latest || latest.hwnd !== hwnd) return null
  return latest.rect
}

function stop() {
  if (child) child.kill()
  child = null
  asked = null
  latest = null
}

module.exports = { poll, boxOf, stop }
