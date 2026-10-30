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
