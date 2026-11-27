const test = require('node:test')
const assert = require('node:assert')
const { hostOfExePath, toolWindowExStyle, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW } = require('../src/win32')

test('hostOfExePath recognizes Claude and Antigravity desktop executables only', () => {
  assert.strictEqual(hostOfExePath('C:\\Users\\tiger\\AppData\\Local\\AnthropicClaude\\Claude.exe'), 'claude')
  assert.strictEqual(hostOfExePath('C:\\Users\\tiger\\.local\\bin\\claude.exe'), null)
  assert.strictEqual(hostOfExePath('C:\\Users\\tiger\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe'), 'antigravity')
  assert.strictEqual(hostOfExePath('C:\\Program Files\\Microsoft VS Code\\Code.exe'), null)
  assert.strictEqual(hostOfExePath(''), null)
})

test('toolWindowExStyle sets WS_EX_TOOLWINDOW and clears WS_EX_APPWINDOW while preserving other bits', () => {
  const WS_EX_LAYERED = 0x00080000
  const WS_EX_TOPMOST = 0x00000008
  const base = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_APPWINDOW
  const next = toolWindowExStyle(base)
  assert.strictEqual(Boolean(next & WS_EX_TOOLWINDOW), true)
  assert.strictEqual(Boolean(next & WS_EX_APPWINDOW), false)
  assert.strictEqual(Boolean(next & WS_EX_LAYERED), true)
  assert.strictEqual(Boolean(next & WS_EX_TOPMOST), true)
  assert.strictEqual(toolWindowExStyle(next), next)
})
