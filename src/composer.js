// Finds the input box (the composer) in the Claude window, so the character can sit on top of it.
//
// Claude's window exposes its page through Windows UI Automation. A hidden PowerShell process reads it:
// the widget writes a window handle on a line, and it answers with the box's screen rectangle in
// physical pixels, as JSON on a line: {"x","y","w","h"}, {} when there is no box, or {"error"}.
// The box is the rounded frame around the prompt editor (a ProseMirror editor), which grows as the
// prompt gets longer. With panes side by side, it is the rightmost one, next to where the character sits.
//
// The same process also closes the "approaching your weekly limit" banner Claude shows above the input
// box: a status bar with the message, a "get more usage" button and a close button. When asked, it looks
// for a close button whose status bar says the weekly limit, and presses it through UI Automation (no
// mouse movement). The question then carries flags: "<hwnd> <box 0|1> <dismiss 0|1>", and an answer may
// add "dismissed" with the banner's text. Claude shows the banner from about 75% of the weekly limit, so
// the widget only asks above BANNER_FROM, every BANNER_EVERY_MS. After closing one it waits until the
// weekly use has grown BANNER_AGAIN points, as Claude does not show it again sooner.

const { spawn } = require('child_process')
const log = require('./log')

// The banner's text, in Chinese or English: 即将达到每周使用限额, Approaching weekly usage limit, …
// No single quotes: it goes into the script inside a PowerShell string.
const LIMIT_BANNER = /每周.{0,12}限额|weekly.{0,24}limit/i
const isLimitBanner = text => LIMIT_BANNER.test(text)

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
$closeCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, '关闭')),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Close')),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Dismiss')))))

# Presses the close button of the weekly limit banner, and returns the banner's text, or $null
function Close-Banner($hwnd) {
  $root = $AE::FromHandle([IntPtr]$hwnd)
  foreach ($b in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $closeCond)) {
    $bar = $walker.GetParent($b)
    if (-not $bar -or $bar.Current.ControlType -ne [System.Windows.Automation.ControlType]::StatusBar) { continue }
    $texts = @()
    $ch = $walker.GetFirstChild($bar)
    while ($ch) {
      if ($ch.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text) { $texts += $ch.Current.Name }
      $ch = $walker.GetNextSibling($ch)
    }
    $text = ($texts -join '').Trim()
    if ($text -notmatch '${LIMIT_BANNER.source}') { continue }
    $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return $text
  }
  return $null
}

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
    $parts = $line.Split(' ')
    $hwnd = [Int64]$parts[0]
    $wantBox = $parts.Length -lt 2 -or $parts[1] -eq '1'
    $wantDismiss = $parts.Length -ge 3 -and $parts[2] -eq '1'
    $fields = @()
    if ($wantDismiss) {
      $closed = Close-Banner $hwnd
      if ($closed) {
        $fields += '"dismissed":' + (ConvertTo-Json ([string]$closed) -Compress)
        $searched = [DateTime]::MinValue
      }
    }
    if ($wantBox) {
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
        else { $fields += '"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height }
      }
    }
    $out = '{' + ($fields -join ',') + '}'
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
const BANNER_FROM = 70 // weekly percent; a little under Claude's 75%, as the widget's figure can lag
const BANNER_EVERY_MS = 3000
const BANNER_AGAIN = 3 // weekly points to wait for after closing the banner
const BANNER_REST_MS = 30 * 60 * 1000 // the wait instead, when the weekly use is not known

// Whether to look for the banner now. weeklyPercent is the highest weekly window's use, or null when
// unknown; dismissed is { at, weeklyPercent } from the last time the banner was closed, or null.
function bannerDue({ weeklyPercent, checkedAt, dismissed, now }) {
  if (weeklyPercent != null && weeklyPercent < BANNER_FROM) return false
  if (dismissed) {
    if (weeklyPercent != null && dismissed.weeklyPercent != null) {
      // Lower than when it was closed: the week started over
      if (weeklyPercent >= dismissed.weeklyPercent && weeklyPercent < dismissed.weeklyPercent + BANNER_AGAIN) return false
    } else if (now - dismissed.at < BANNER_REST_MS) return false
  }
  return checkedAt == null || now - checkedAt >= BANNER_EVERY_MS
}

let child = null
let asked = null // { hwnd, at } while a question is out
let latest = null // { hwnd, rect, at }
let lastStart = 0
let lastError = null
let bannerCheckedAt = null
let bannerDismissed = null // { at, weeklyPercent }
let lastWeekly = null

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
  if (value.dismissed) bannerDismissed = { at: Date.now(), weeklyPercent: lastWeekly }
  if (value.dismissed) log.info('closed the weekly limit banner:', value.dismissed)
  const rect = Number.isFinite(value.x) && value.w > 0 && value.h > 0
    ? { left: value.x, top: value.y, right: value.x + value.w, bottom: value.y + value.h }
    : null
  latest = { hwnd, rect, at: Date.now() }
}

// Asks for the box of the window `hwnd` (with box) at most every POLL_MS, and, with dismiss, closes its
// weekly limit banner when bannerDue says so
function poll(hwnd, { box = true, dismiss = false, weeklyPercent = null } = {}) {
  const now = Date.now()
  if (asked) {
    if (now - asked.at < STALL_MS) return
    log.warn('input box reader stopped answering, restarting it')
    stop()
  }
  lastWeekly = weeklyPercent
  const closeBanner = dismiss && bannerDue({ weeklyPercent, checkedAt: bannerCheckedAt, dismissed: bannerDismissed, now })
  if (!closeBanner && (!box || (latest && latest.hwnd === hwnd && now - latest.at < POLL_MS))) return
  if (!child) start()
  if (!child) return
  asked = { hwnd, at: now }
  if (closeBanner) bannerCheckedAt = now
  child.stdin.write(`${hwnd} ${box ? 1 : 0} ${closeBanner ? 1 : 0}\n`)
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

module.exports = { poll, boxOf, stop, isLimitBanner, bannerDue }
