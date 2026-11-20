// Finds the input box (the composer) in the Claude or Antigravity window, so the character can sit
// on top of it, and for Antigravity also reads the active model label near the composer.
//
// Electron windows expose their page through Windows UI Automation. A hidden PowerShell process
// reads it: the widget writes a request line:
//   "<hwnd> <box 0|1> <dismiss 0|1> <host claude|antigravity> <model 0|1>"
// and it answers with JSON on a line: {"x","y","w","h","wx","wy","ww","wh","model","dismissed"},
// {}, or {"error"}. The reader asks to be per-monitor DPI aware, and fitToWindow corrects scaled
// coordinates using the window's reported rectangle ("wx","wy","ww","wh") against the real one.
//
// For Claude, the box is the rounded frame around the ProseMirror prompt editor (rightmost when
// panes are side by side). The same process also closes Claude's "approaching your weekly limit"
// banner above the input box when weekly use is above BANNER_FROM.
//
// For Antigravity, it locates the chat composer editor and its rounded wrapper, and inspects
// nearby buttons/comboboxes for the selected model name (e.g. "Gemini 4 Neon (High)", "Claude Sonnet 4.6").

const { spawn } = require('child_process')
const log = require('./log')

// The banner's text, in Chinese or English: 即将达到每周使用限额, Approaching weekly usage limit, …
// No single quotes: it goes into the script inside a PowerShell string.
const LIMIT_BANNER = /每周.{0,12}限额|weekly.{0,24}limit/i
const isLimitBanner = text => LIMIT_BANNER.test(text)

// Model selector button/label patterns near Antigravity's composer (no single quotes).
const MODEL_LABEL = /\b(?:gemini|claude|gpt|sonnet|opus|haiku|orchestrator|o[134])(?:[\w.\-/+\s()高中低]*[\w)高中低])?/i
const MENU_BADGE = /新建|通知|不可用|unavailable|disabled|查看用量|view usage/i

function isModelLabel(text) {
  if (typeof text !== 'string') return false
  const clean = text.trim()
  if (!clean || clean.length > 48 || /[\r\n,;!?\u3002\uff0c\uff01\uff1f\uff1b]/.test(clean)) return false
  if (/https?:\/\/|[\\/]{2,}/.test(clean) || MENU_BADGE.test(clean)) return false
  return MODEL_LABEL.test(clean)
}

function extractModelLabel(text) {
  if (!isModelLabel(text)) return null
  const clean = text.trim()
  const match = clean.match(MODEL_LABEL)
  return match ? match[0].trim() : clean
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Real pixels even after the display scale changes; otherwise Windows scales what UI Automation reports
try {
  Add-Type -Namespace Whale -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c); [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);'
  [void][Whale.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
  [void][Whale.Dpi]::SetThreadDpiAwarenessContext([IntPtr](-4))
} catch {}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$editCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$docCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$textCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
$modelCond = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ComboBox)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))
$box = $null
$boxHwnd = 0
$boxHost = ''
$searched = [DateTime]::MinValue
$modelSearched = [DateTime]::MinValue
$cachedModel = $null
$debuggedHwnd = 0
$lastDebug = $null
$closeCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, '关闭')),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Close')),
    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Dismiss')))))

# Presses the close button of Claude's weekly limit banner, and returns the banner's text, or $null
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

function Find-ClaudeBox($hwnd) {
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

function Climb-AntigravityCard($anchor, $rootRect, $requireBigger) {
  $anchorRect = $anchor.Current.BoundingRectangle
  $anchorHeight = $anchorRect.Height
  $fallback = if ($requireBigger) { $null } else { $anchor }
  $cur = $anchor
  for ($i = 0; $i -lt 10; $i++) {
    $cur = $walker.GetParent($cur)
    if (-not $cur) { break }
    $c = $cur.Current
    $r = $c.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -gt $rootRect.Width * 0.95 -or $r.Height -gt $rootRect.Height * 0.55) { break }
    if ($r.Width -lt 240 -or $r.Height -lt 48) { continue }
    if ($c.ClassName -match '(^|\s)rounded|composer|prompt|chat-input|input-box' -and $r.Height -ge $anchorHeight + 8) { return $cur }
    if (-not $fallback -and $r.Height -ge [Math]::Max($anchorHeight + 16, 56) -and $r.Height -le [Math]::Min($anchorHeight + 180, $rootRect.Height * 0.45)) {
      $fallback = $cur
    }
  }
  return $fallback
}

function Find-AntigravityBox($hwnd) {
  $root = $AE::FromHandle([IntPtr]$hwnd)
  $rootRect = $root.Current.BoundingRectangle
  if ($rootRect.IsEmpty -or $rootRect.Width -le 0) { return $null }
  $best = $null
  $bestScore = -1
  $candidates = @()
  $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
  foreach ($e in $edits) { $candidates += $e }
  $docs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)
  foreach ($d in $docs) {
    $r = $d.Current.BoundingRectangle
    if (-not $r.IsEmpty -and $r.Width -ge 160 -and $r.Width -lt $rootRect.Width * 0.95 -and $r.Height -ge 16 -and $r.Height -lt $rootRect.Height * 0.55) {
      $candidates += $d
    }
  }
  foreach ($e in $candidates) {
    $c = $e.Current
    $r = $c.BoundingRectangle
    if ($c.IsOffscreen -or $r.IsEmpty -or $r.Width -lt 140 -or $r.Height -lt 14) { continue }
    if ($r.Height -gt $rootRect.Height * 0.6) { continue }
    $meta = ([string]$c.ClassName + ' ' + [string]$c.Name + ' ' + [string]$c.HelpText + ' ' + [string]$c.AutomationId)
    $looksChat = $meta -match 'ProseMirror|Lexical|tiptap|composer|prompt|message|chat|ask|anything|询问|输入|任何问题|提及|触发|消息|对话'
    $inLowerHalf = $r.Top -ge ($rootRect.Top + $rootRect.Height * 0.35)
    if (-not $looksChat -and -not $inLowerHalf) { continue }
    $score = 0
    if ($looksChat) { $score += 10000 }
    if ($inLowerHalf) { $score += 2000 }
    $score += [int]($r.Bottom - $rootRect.Top)
    $score += [int]($r.Right - $rootRect.Left)
    if ($score -gt $bestScore) {
      $bestScore = $score
      $best = $e
    }
  }
  if ($best) { return Climb-AntigravityCard $best $rootRect $false }

  # Fallback: anchor on Antigravity 2.0's bottom composer placeholder text or model picker button
  $minTop = $rootRect.Top + $rootRect.Height * 0.48
  foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)) {
    $c = $t.Current
    $r = $c.BoundingRectangle
    if ($c.IsOffscreen -or $r.IsEmpty -or $r.Top -lt $minTop) { continue }
    if ([string]$c.Name -match '输入任何问题|Ask anything|@ 提及|@ to mention|触发操作|for workflows') {
      $card = Climb-AntigravityCard $t $rootRect $true
      if ($card) { return $card }
    }
  }
  foreach ($b in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $modelCond)) {
    $c = $b.Current
    $r = $c.BoundingRectangle
    if ($c.IsOffscreen -or $r.IsEmpty -or $r.Top -lt $minTop) { continue }
    if (Match-ModelText $c.Name) {
      $card = Climb-AntigravityCard $b $rootRect $true
      if ($card) { return $card }
    }
  }

  # Log a compact one-time UIA summary per window when nothing matched, so any layout change is diagnosable
  if ($hwnd -ne $debuggedHwnd) {
    $debuggedHwnd = $hwnd
    $samples = @()
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
      if ($samples.Count -ge 10) { break }
      $c = $el.Current
      $r = $c.BoundingRectangle
      if ($c.IsOffscreen -or $r.IsEmpty -or $r.Top -lt $minTop) { continue }
      $ct = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if ($ct -in @('Edit','Document','Button','ComboBox','Text','Group')) {
        $nm = ([string]$c.Name).Replace([char]13,'').Replace([char]10,'')
        if ($nm.Length -gt 24) { $nm = $nm.Substring(0, 24) }
        $cn = ([string]$c.ClassName)
        if ($cn.Length -gt 24) { $cn = $cn.Substring(0, 24) }
        $samples += "$ct($cn|$nm|$([int]$r.Width)x$([int]$r.Height)@$([int]$r.Left),$([int]$r.Top))"
      }
    }
    $script:lastDebug = "root=$([int]$rootRect.Width)x$([int]$rootRect.Height) all=$($all.Count) edits=$($edits.Count) docs=$($docs.Count) bottom=[" + ($samples -join '; ') + ']'
  }
  return $null
}

function Match-ModelText($text) {
  if (-not $text) { return $null }
  $t = ([string]$text).Trim()
  if ($t.Length -eq 0 -or $t.Length -gt 48 -or $t -match '[\r\n,;!?。，！？；]|https?://|新建|通知|不可用|查看用量') { return $null }
  if ($t -match '${MODEL_LABEL.source}') { return $matches[0].Trim() }
  return $null
}

function Find-AntigravityModel($hwnd, $boxEl) {
  $root = $AE::FromHandle([IntPtr]$hwnd)
  $rootRect = $root.Current.BoundingRectangle
  $scopes = @()
  if ($boxEl) {
    $scopes += $boxEl
    $p1 = $walker.GetParent($boxEl)
    if ($p1) { $scopes += $p1 }
  }
  $bestHit = $null
  $bestBottom = -1
  foreach ($scope in $scopes) {
    foreach ($el in $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $modelCond)) {
      $c = $el.Current
      $r = $c.BoundingRectangle
      if ($c.IsOffscreen -or $r.IsEmpty) { continue }
      $hit = Match-ModelText $c.Name
      if (-not $hit) { $hit = Match-ModelText $c.HelpText }
      if ($hit -and $r.Bottom -gt $bestBottom) {
        $bestBottom = $r.Bottom
        $bestHit = $hit
      }
    }
    if ($bestHit) { return $bestHit }
  }
  if (-not $rootRect.IsEmpty) {
    $minTop = $rootRect.Top + $rootRect.Height * 0.65
    foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $modelCond)) {
      $c = $el.Current
      $r = $c.BoundingRectangle
      if ($c.IsOffscreen -or $r.IsEmpty -or $r.Top -lt $minTop) { continue }
      $hit = Match-ModelText $c.Name
      if ($hit -and $r.Bottom -gt $bestBottom) {
        $bestBottom = $r.Bottom
        $bestHit = $hit
      }
    }
  }
  return $bestHit
}

function Find-AntigravityUsageTexts($hwnd) {
  $root = $AE::FromHandle([IntPtr]$hwnd)
  $anchor = $null
  foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)) {
    $c = $t.Current
    if ($c.IsOffscreen) { continue }
    $nm = ([string]$c.Name).Trim()
    if ($nm -eq '使用情况' -or $nm -eq 'Usage') {
      $anchor = $t
      break
    }
  }
  if (-not $anchor) { return $null }
  $panel = $anchor
  for ($i = 0; $i -lt 5; $i++) {
    $p = $walker.GetParent($panel)
    if (-not $p) { break }
    $pr = $p.Current.BoundingRectangle
    if (-not $pr.IsEmpty -and $pr.Height -ge 120 -and $pr.Width -ge 160 -and $pr.Height -le 700) {
      $panel = $p
      break
    }
    $panel = $p
  }
  $items = @()
  foreach ($t in $panel.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)) {
    $c = $t.Current
    $r = $c.BoundingRectangle
    if ($c.IsOffscreen -or $r.IsEmpty) { continue }
    $nm = ([string]$c.Name).Trim()
    if ($nm.Length -gt 0 -and $nm.Length -le 80) {
      $key = ([int]($r.Top / 6)) * 10000 + [int]$r.Left
      $items += [PSCustomObject]@{ Key = $key; Text = $nm }
    }
  }
  if ($items.Count -lt 3) { return $null }
  return @($items | Sort-Object Key | ForEach-Object { $_.Text })
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $out = '{}'
  try {
    $parts = $line.Split(' ')
    $hwnd = [Int64]$parts[0]
    $wantBox = $parts.Length -lt 2 -or $parts[1] -eq '1'
    $wantDismiss = $parts.Length -ge 3 -and $parts[2] -eq '1'
    $hostType = if ($parts.Length -ge 4 -and $parts[3]) { $parts[3] } else { 'claude' }
    $wantModel = $parts.Length -ge 5 -and $parts[4] -eq '1'
    $fields = @()
    if ($wantDismiss -and $hostType -eq 'claude') {
      $closed = Close-Banner $hwnd
      if ($closed) {
        $fields += '"dismissed":' + (ConvertTo-Json ([string]$closed) -Compress)
        $searched = [DateTime]::MinValue
      }
    }
    if ($wantBox) {
      $age = ([DateTime]::UtcNow - $searched).TotalSeconds
      if ($hwnd -ne $boxHwnd -or $hostType -ne $boxHost -or ((-not $box) -and $age -gt 1) -or $age -gt 5) {
        $searched = [DateTime]::UtcNow
        $boxHwnd = $hwnd
        $boxHost = $hostType
        $box = if ($hostType -eq 'antigravity') { Find-AntigravityBox $hwnd } else { Find-ClaudeBox $hwnd }
      }
      if ($box) {
        $c = $box.Current
        $r = $c.BoundingRectangle
        if ($c.IsOffscreen -or $r.IsEmpty -or $r.Width -le 0) { $box = $null }
        else {
          $fields += '"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height
          $wr = $AE::FromHandle([IntPtr]$hwnd).Current.BoundingRectangle
          if (-not $wr.IsEmpty) { $fields += '"wx":' + [int]$wr.X + ',"wy":' + [int]$wr.Y + ',"ww":' + [int]$wr.Width + ',"wh":' + [int]$wr.Height }
        }
      }
    }
    if ($wantModel -and $hostType -eq 'antigravity') {
      $mAge = ([DateTime]::UtcNow - $modelSearched).TotalSeconds
      if ($hwnd -ne $boxHwnd -or $mAge -ge 0.8) {
        $modelSearched = [DateTime]::UtcNow
        $cachedModel = Find-AntigravityModel $hwnd $box
        $usageTexts = Find-AntigravityUsageTexts $hwnd
        if ($usageTexts) {
          $fields += '"usageTexts":' + (ConvertTo-Json $usageTexts -Compress)
        }
      }
      if ($cachedModel) {
        $fields += '"model":' + (ConvertTo-Json ([string]$cachedModel) -Compress)
      }
    }
    if ($script:lastDebug) {
      $fields += '"debug":' + (ConvertTo-Json ([string]$script:lastDebug) -Compress)
      $script:lastDebug = $null
    }
    $out = '{' + ($fields -join ',') + '}'
  } catch {
    $box = $null
    $cachedModel = $null
    $out = '{"error":' + (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}'
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
`

const POLL_MS = 200 // how often to ask while the character follows the box
const MODEL_ONLY_POLL_MS = 1000 // how often to check model label when snapToBox is off
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
let asked = null // { hwnd, host, at } while a question is out
let latest = null // { hwnd, host, rect, model, at }
let lastStart = 0
let lastError = null
let bannerCheckedAt = null
let bannerDismissed = null // { at, weeklyPercent }
let lastWeekly = null

function start() {
  if (Date.now() - lastStart < RESTART_MS) return
  lastStart = Date.now()
  // Pass SCRIPT via environment variable instead of -EncodedCommand so it never hits Windows's
  // 32,767-char command-line limit (ENAMETOOLONG) and is unaffected by PowerShell ExecutionPolicy.
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Expression $env:WHALE_UIA_SCRIPT'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WHALE_UIA_SCRIPT: SCRIPT },
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
  const { hwnd, host } = asked
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
  if (value.debug) log.info('uia diagnostic:', value.debug)
  if (value.dismissed) bannerDismissed = { at: Date.now(), weeklyPercent: lastWeekly }
  if (value.dismissed) log.info('closed the weekly limit banner:', value.dismissed)
  const rect = Number.isFinite(value.x) && value.w > 0 && value.h > 0
    ? { left: value.x, top: value.y, right: value.x + value.w, bottom: value.y + value.h }
    : null
  const frame = rect && Number.isFinite(value.wx) && value.ww > 0 && value.wh > 0
    ? { left: value.wx, top: value.wy, right: value.wx + value.ww, bottom: value.wy + value.wh }
    : null
  const model = typeof value.model === 'string' && value.model.trim() ? extractModelLabel(value.model) : null
  const usageTexts = Array.isArray(value.usageTexts) && value.usageTexts.length > 0 ? value.usageTexts : null
  latest = { hwnd, host, rect, frame, model, usageTexts, at: Date.now() }
}

// Asks for the box of the window `hwnd` (with box) at most every POLL_MS, closes Claude's weekly
// limit banner when bannerDue says so, and reads Antigravity's model label when detectModel is true.
function poll(hwnd, { host = 'claude', box = true, dismiss = false, weeklyPercent = null, detectModel = false } = {}) {
  const now = Date.now()
  if (asked) {
    if (now - asked.at < STALL_MS) return
    log.warn('input box reader stopped answering, restarting it')
    stop()
  }
  lastWeekly = weeklyPercent
  const closeBanner =
    host === 'claude' && dismiss && bannerDue({ weeklyPercent, checkedAt: bannerCheckedAt, dismissed: bannerDismissed, now })
  const wantModel = host === 'antigravity' && detectModel
  const cadence = box ? POLL_MS : MODEL_ONLY_POLL_MS
  if (!closeBanner && !box && !wantModel) return
  if (!closeBanner && latest && latest.hwnd === hwnd && latest.host === host && now - latest.at < cadence) return
  if (!child) start()
  if (!child) return
  asked = { hwnd, host, at: now }
  if (closeBanner) bannerCheckedAt = now
  child.stdin.write(`${hwnd} ${box ? 1 : 0} ${closeBanner ? 1 : 0} ${host} ${wantModel ? 1 : 0}\n`)
}

// Maps the box from the window rectangle UI Automation reported (seen) to the window's real one
// (physical pixels), when Windows scaled the reader's coordinates. A display scale change scales both
// sides alike and by at least a step (125% to 150% is 1.2); a window being resized changes them unevenly
// or a little between the answer and now, so that is left alone.
function fitToWindow(rect, seen, real) {
  if (!rect || !seen || !real) return rect
  const sx = (real.right - real.left) / (seen.right - seen.left)
  const sy = (real.bottom - real.top) / (seen.bottom - seen.top)
  if (!(sx > 0 && sy > 0) || Math.abs(sx - 1) < 0.05 || Math.abs(sx / sy - 1) > 0.02) return rect
  const x = v => Math.round(real.left + (v - seen.left) * sx)
  const y = v => Math.round(real.top + (v - seen.top) * sy)
  return { left: x(rect.left), top: y(rect.top), right: x(rect.right), bottom: y(rect.bottom) }
}

let lastScaled = null

// The box's last known rectangle (physical pixels: left, top, right, bottom), or null. windowRect is
// the Claude window's real outer rectangle (GetWindowRect), to correct coordinates Windows scaled.
// It may be from before the character was last hidden; the next answer, a moment later, corrects it.
function boxOf(hwnd, windowRect = null) {
  if (!latest || latest.hwnd !== hwnd) return null
  const rect = fitToWindow(latest.rect, latest.frame, windowRect)
  const scaled = rect !== latest.rect
  if (scaled !== lastScaled) {
    if (scaled) log.info('input box coordinates were scaled by Windows, correcting', JSON.stringify(latest.frame), JSON.stringify(windowRect))
    lastScaled = scaled
  }
  return rect
}

// The model label read near Antigravity's composer for `hwnd`, or null.
function modelOf(hwnd) {
  if (!latest || latest.hwnd !== hwnd || latest.host !== 'antigravity') return null
  return latest.model
}

// Text lines read from Antigravity's "使用情况 / Usage" popup when open, or null.
function usageTextsOf(hwnd) {
  if (!latest || latest.hwnd !== hwnd || latest.host !== 'antigravity') return null
  return latest.usageTexts
}

function stop() {
  if (child) child.kill()
  child = null
  asked = null
  latest = null
}

module.exports = { poll, boxOf, modelOf, usageTextsOf, stop, isLimitBanner, isModelLabel, extractModelLabel, bannerDue, fitToWindow }
