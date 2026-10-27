// Updates come from this repository's GitHub releases, the way the EhViewer fork does it.
//
// Every push to main publishes a numbered release ("v0.1.0-t3", see .github/workflows/build.yml) with
// update.json attached: the fields of the API's release object that matter here. It is fetched from
// /releases/latest/download/update.json, which, unlike api.github.com (60 requests an hour per IP
// without login), has no request limit; releases without it fall back to the API.

const { app, net } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const log = require('./log')
const { isNewer } = require('./version')

const REPO = 'tiger-git2022/whale-usage'
const RELEASES_URL = `https://github.com/${REPO}/releases`
const LATEST_MANIFEST_URL = `${RELEASES_URL}/latest/download/update.json`
const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

// electron-builder's portable exe sets these; the installed app does not.
const portableFile = () => process.env.PORTABLE_EXECUTABLE_FILE || null

async function getJson(url) {
  const response = await net.fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': `WhaleUsage/${app.getVersion()}` },
  })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function fetchLatestRelease() {
  try {
    return await getJson(LATEST_MANIFEST_URL)
  } catch (err) {
    log.warn('update manifest unavailable, asking the API:', err.message)
    return getJson(LATEST_API_URL)
  }
}

/** The newer release, or null when this build is the latest. */
async function checkForUpdate() {
  const release = await fetchLatestRelease()
  const latest = String(release.tag_name).replace(/^v/, '')
  const current = app.getVersion()
  const newer = isNewer(latest, current)
  log.info(`update check: running ${current}, latest ${latest}, ${newer ? 'update available' : 'up to date'}`)
  if (!newer) return null
  return {
    version: latest,
    notes: release.body || '',
    pageUrl: release.html_url || `${RELEASES_URL}/tag/v${latest}`,
    assets: (release.assets || []).map(a => ({ name: a.name, url: a.browser_download_url })),
  }
}

function pickAsset(update) {
  return update.assets.find(a => a.name.endsWith('-portable.exe')) ?? null
}

async function download(url, target, onProgress) {
  const response = await net.fetch(url)
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || null
  const out = fs.createWriteStream(target)
  let done = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      done += value.length
      if (!out.write(Buffer.from(value))) await new Promise(resolve => out.once('drain', resolve))
      onProgress(done, total)
    }
  } finally {
    await new Promise(resolve => out.end(resolve))
  }
  if (total && done !== total) throw new Error(`download incomplete: ${done} of ${total} bytes`)
}

// The portable exe stays locked while this copy runs (its launcher keeps it open), so a small script
// waits for it to close, moves the new exe over it and starts it. ping is the delay because timeout
// does not work without a console.
function swapScript(fresh, target) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    `set "SRC=${fresh}"`,
    `set "DST=${target}"`,
    'for /l %%i in (1,1,120) do (',
    '  move /y "%SRC%" "%DST%" >nul 2>&1 && goto started',
    '  ping -n 2 127.0.0.1 >nul',
    ')',
    'exit /b 1',
    ':started',
    'start "" "%DST%"',
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n')
}

/**
 * Downloads the update beside this exe; once this copy quits, a script moves it over the old exe
 * and starts it. Only the portable exe updates itself (a source checkout has no exe to replace).
 */
async function installUpdate(update, onProgress) {
  const portable = portableFile()
  if (!portable) throw new Error('只有打包好的 exe 能自动更新，源码运行请用 git pull')
  const asset = pickAsset(update)
  if (!asset) throw new Error('这个版本没有可下载的 exe')
  log.info('downloading', asset.name)

  const fresh = `${portable}.new`
  await download(asset.url, fresh, onProgress)
  const script = path.join(os.tmpdir(), `whale-usage-update-${Date.now()}.cmd`)
  fs.writeFileSync(script, swapScript(fresh, portable), 'utf8')
  log.info('replacing', portable, 'after quitting, via', script)
  app.releaseSingleInstanceLock()
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  app.quit()
}

/** Removes what an interrupted portable update left behind. */
function cleanUpAfterUpdate() {
  const portable = portableFile()
  if (!portable) return
  for (const leftover of [`${portable}.new`]) {
    try {
      if (fs.existsSync(leftover)) {
        fs.rmSync(leftover, { force: true })
        log.info('removed', leftover)
      }
    } catch (err) {
      log.warn('could not remove', leftover, err.message)
    }
  }
}

module.exports = { checkForUpdate, installUpdate, cleanUpAfterUpdate, RELEASES_URL }
