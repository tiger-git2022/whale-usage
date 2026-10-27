// Updates come from this repository's GitHub releases, the way the EhViewer fork does it.
//
// Every push to main publishes a numbered release ("v0.1.0-t3", see .github/workflows/build.yml) with
// update.json attached: the fields of the API's release object that matter here. It is fetched from
// /releases/latest/download/update.json, which, unlike api.github.com (60 requests an hour per IP
// without login), has no request limit; releases without it fall back to the API.

const { app, net } = require('electron')
const fs = require('fs')
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
// How the new exe is told to put itself in place: `<new exe> --whale-finish-update <old exe>`
const FINISH_FLAG = '--whale-finish-update'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Downloads the update beside this exe as `<exe>.new`, starts it to finish the update, and quits.
 *
 * The running exe cannot be replaced or renamed (Windows locks it), and a helper script would need a
 * console program, which shows a window. So the new exe does the swap itself (finishUpdate): it is a
 * windowed program like this one, needs no script, and Chinese or other characters in paths are fine.
 * Only the portable exe updates itself (a source checkout has no exe to replace).
 */
async function installUpdate(update, onProgress) {
  const portable = portableFile()
  if (!portable) throw new Error('只有打包好的 exe 能自动更新，源码运行请用 git pull')
  const asset = pickAsset(update)
  if (!asset) throw new Error('这个版本没有可下载的 exe')
  log.info('downloading', asset.name)

  const fresh = `${portable}.new`
  await download(asset.url, fresh, onProgress)
  log.info('starting the new version to replace', portable)
  app.releaseSingleInstanceLock()
  spawn(fresh, [FINISH_FLAG, portable], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

/** The old exe to replace, when this copy was started to finish an update; otherwise null. */
function finishTarget() {
  const at = process.argv.indexOf(FINISH_FLAG)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : null
}

/**
 * Run by the new exe (`<old exe>.new`): waits for the old copy to quit, copies itself over it and
 * starts it. A copy, not a move: this file is in use while it runs. The started copy removes it.
 */
async function finishUpdate(target) {
  const self = portableFile()
  if (!self) return log.error('finish update: not started as the portable exe')
  let lastError = null
  for (let i = 0; i < 120; i++) {
    try {
      fs.copyFileSync(self, target)
      log.info('update finished, starting', target)
      spawn(target, [], { detached: true, stdio: 'ignore' }).unref()
      return
    } catch (err) {
      lastError = err
      await sleep(1000)
    }
  }
  log.error('finish update: could not replace', target, lastError)
}

/**
 * Removes the `<exe>.new` an update left behind. Right after an update the copy that finished it may
 * still be closing, so this keeps trying for a minute.
 */
async function cleanUpAfterUpdate() {
  const portable = portableFile()
  if (!portable) return
  const leftover = `${portable}.new`
  for (let i = 0; i < 30 && fs.existsSync(leftover); i++) {
    try {
      fs.rmSync(leftover, { force: true })
      log.info('removed', leftover)
      return
    } catch (err) {
      if (i === 29) log.warn('could not remove', leftover, err.message)
      await sleep(2000)
    }
  }
}

module.exports = { checkForUpdate, installUpdate, finishTarget, finishUpdate, cleanUpAfterUpdate, RELEASES_URL }
