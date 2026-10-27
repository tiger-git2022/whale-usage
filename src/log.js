// A small run log in <userData>/logs/main.log, kept under 1 MB (the previous one is main.old.log).
// The tray menu opens the folder; it is what to look at when the widget or an update misbehaves.

const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_BYTES = 1024 * 1024
let file = null

function init(dir) {
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'main.log')
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, 'main.old.log'))
  } catch {}
}

let failed = false // the log file could not be written; said once, in the temp folder

// The file comes first: the packaged exe has no console, and writing to one may fail or stall.
function write(level, args) {
  const text = args.map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const line = `${new Date().toISOString()} ${level} ${text}\n`
  if (file) {
    try {
      fs.appendFileSync(file, line)
    } catch (err) {
      if (!failed) {
        failed = true
        try {
          fs.appendFileSync(path.join(os.tmpdir(), 'whale-usage-log-error.txt'), `${line.trim()}\n  cannot write ${file}: ${err.stack}\n`)
        } catch {}
      }
    }
  }
  if (app.isPackaged) return
  try {
    ;(level === 'ERROR' ? process.stderr : process.stdout).write(line)
  } catch {}
}

module.exports = {
  init,
  dir: () => (file ? path.dirname(file) : null),
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
}
