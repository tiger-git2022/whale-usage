const test = require('node:test')
const assert = require('node:assert')
const {
  isTempExecutablePath,
  resolvePortableExe,
  loginItemOptions,
  parseRunEntryPath,
} = require('../src/updater')

test('isTempExecutablePath detects unpacked portable stubs inside temp dir only', () => {
  const tmp = 'C:\\Users\\tiger\\AppData\\Local\\Temp'
  assert.strictEqual(
    isTempExecutablePath('C:\\Users\\tiger\\AppData\\Local\\Temp\\3MPf6aRRmT560SpDrFpO723ZOU4\\Whale Usage.exe', tmp),
    true,
  )
  assert.strictEqual(
    isTempExecutablePath('c:/users/tiger/appdata/local/temp/abc/Whale Usage.exe', tmp),
    true,
  )
  assert.strictEqual(isTempExecutablePath('C:\\Users\\tiger\\AppData\\Local\\Temp2\\Whale Usage.exe', tmp), false)
  assert.strictEqual(isTempExecutablePath('C:\\AI应用\\WhaleUsage-v0.10.0-portable.exe', tmp), false)
  assert.strictEqual(isTempExecutablePath('', tmp), false)
})

test('resolvePortableExe prefers env var and recovers saved portable exe when launched from temp stub', () => {
  const tmp = 'C:\\Users\\tiger\\AppData\\Local\\Temp'
  assert.strictEqual(
    resolvePortableExe({
      envPortable: 'C:\\AI应用\\WhaleUsage.exe',
      execPath: `${tmp}\\hash\\Whale Usage.exe`,
      savedPortable: 'C:\\Old\\Whale.exe',
      existsSync: () => true,
      tmpDir: tmp,
    }),
    'C:\\AI应用\\WhaleUsage.exe',
  )
  assert.strictEqual(
    resolvePortableExe({
      envPortable: '',
      execPath: `${tmp}\\hash\\Whale Usage.exe`,
      savedPortable: 'C:\\AI应用\\WhaleUsage.exe',
      existsSync: p => p === 'C:\\AI应用\\WhaleUsage.exe',
      tmpDir: tmp,
    }),
    'C:\\AI应用\\WhaleUsage.exe',
  )
  // Does not falsely treat a source / non-temp run as portable
  assert.strictEqual(
    resolvePortableExe({
      envPortable: '',
      execPath: 'C:\\AI应用\\Claude Whale\\node_modules\\electron\\dist\\electron.exe',
      savedPortable: 'C:\\AI应用\\WhaleUsage.exe',
      existsSync: () => true,
      tmpDir: tmp,
    }),
    null,
  )
  // Returns null if saved portable exe no longer exists
  assert.strictEqual(
    resolvePortableExe({
      envPortable: '',
      execPath: `${tmp}\\hash\\Whale Usage.exe`,
      savedPortable: 'C:\\Missing\\WhaleUsage.exe',
      existsSync: () => false,
      tmpDir: tmp,
    }),
    null,
  )
})

test('loginItemOptions passes portable path so Windows autostart never registers the temp binary', () => {
  assert.deepStrictEqual(loginItemOptions(true, 'C:\\AI应用\\WhaleUsage.exe'), {
    openAtLogin: true,
    path: 'C:\\AI应用\\WhaleUsage.exe',
  })
  assert.deepStrictEqual(loginItemOptions(false, null), { openAtLogin: false })
})

test('parseRunEntryPath extracts exe paths from quoted and unquoted Windows Run values', () => {
  assert.strictEqual(
    parseRunEntryPath('"C:\\Users\\tiger\\AppData\\Local\\Temp\\3MPf\\Whale Usage.exe"'),
    'C:\\Users\\tiger\\AppData\\Local\\Temp\\3MPf\\Whale Usage.exe',
  )
  assert.strictEqual(
    parseRunEntryPath('"C:\\AI应用\\WhaleUsage-v0.1.0-t5-portable.exe" --autostart'),
    'C:\\AI应用\\WhaleUsage-v0.1.0-t5-portable.exe',
  )
  assert.strictEqual(
    parseRunEntryPath('C:\\AI应用\\WhaleUsage.exe --hidden'),
    'C:\\AI应用\\WhaleUsage.exe',
  )
  assert.strictEqual(parseRunEntryPath(''), null)
})
