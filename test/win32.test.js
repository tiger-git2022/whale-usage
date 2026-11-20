const test = require('node:test')
const assert = require('node:assert')
const { hostOfExePath } = require('../src/win32')

test('hostOfExePath recognizes Claude and Antigravity desktop executables only', () => {
  assert.strictEqual(hostOfExePath('C:\\Users\\tiger\\AppData\\Local\\AnthropicClaude\\Claude.exe'), 'claude')
  assert.strictEqual(hostOfExePath('C:\\Users\\tiger\\.local\\bin\\claude.exe'), null)
  assert.strictEqual(hostOfExePath('C:\\Users\\tiger\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe'), 'antigravity')
  assert.strictEqual(hostOfExePath('C:\\Program Files\\Microsoft VS Code\\Code.exe'), null)
  assert.strictEqual(hostOfExePath(''), null)
})
