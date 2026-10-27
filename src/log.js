// A small run log in <userData>/logs/main.log, kept under 1 MB (the previous one is main.old.log).
// The tray menu opens the folder; it is what to look at when the widget or an update misbehaves.

const fs = require('fs')
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

function write(level, args) {
  const text = args.map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const line = `${new Date().toISOString()} ${level} ${text}\n`
  try {
    ;(level === 'ERROR' ? process.stderr : process.stdout).write(line)
  } catch {}
  if (!file) return
  try {
    fs.appendFileSync(file, line)
  } catch {}
}

module.exports = {
  init,
  dir: () => (file ? path.dirname(file) : null),
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
}
