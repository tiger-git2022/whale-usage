const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isNewer } = require('../src/version')

test('a higher build number is newer', () => {
  assert.equal(isNewer('v0.1.0-t3', '0.1.0-t2'), true)
  assert.equal(isNewer('0.1.0-t10', '0.1.0-t9'), true)
  assert.equal(isNewer('0.1.0-t2', '0.1.0-t2'), false)
  assert.equal(isNewer('0.1.0-t1', '0.1.0-t2'), false)
})

test('three-digit build numbers compare with the older unpadded ones', () => {
  assert.equal(isNewer('v0.1.0-t013', '0.1.0-t12'), true)
  assert.equal(isNewer('0.1.0-t013', '0.1.0-t013'), false)
  assert.equal(isNewer('0.1.0-t100', '0.1.0-t099'), true)
  assert.equal(isNewer('0.1.0-t012', '0.1.0-t9'), true)
})

test('the base version comes first', () => {
  assert.equal(isNewer('0.2.0-t1', '0.1.0-t9'), true)
  assert.equal(isNewer('0.1.1-t1', '0.1-t5'), true)
  assert.equal(isNewer('0.0.9-t9', '0.1.0-t1'), false)
})

test('builds without a release number', () => {
  // A local build is older than any release
  assert.equal(isNewer('0.1.0-t1', '0.1.0'), true)
  // A release without a number (the first v0.1.0) is never offered
  assert.equal(isNewer('v0.1.0', '0.1.0-t1'), false)
  assert.equal(isNewer('0.1.0', '0.1.0'), false)
})

test('plain versions are newer than the old numbered ones', () => {
  assert.equal(isNewer('v0.8.0', '0.1.0-t015'), true)
  assert.equal(isNewer('0.8.0', '0.1.0-t9'), true)
  assert.equal(isNewer('0.1.0-t016', '0.8.0'), false)
})

test('plain versions compare by number', () => {
  assert.equal(isNewer('v0.8.1', '0.8.0'), true)
  assert.equal(isNewer('0.9.0', '0.8.12'), true)
  assert.equal(isNewer('0.8.10', '0.8.9'), true)
  assert.equal(isNewer('1.0.0', '0.99.99'), true)
  assert.equal(isNewer('0.8.0', '0.8.0'), false)
  assert.equal(isNewer('0.7.9', '0.8.0'), false)
})
