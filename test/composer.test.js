const test = require('node:test')
const assert = require('node:assert')
const { isLimitBanner, bannerDue } = require('../src/composer')

test('isLimitBanner knows the weekly limit banner in Chinese and English', () => {
  assert.ok(isLimitBanner('即将达到每周使用限额11月8日周日 23:00 重置'))
  assert.ok(isLimitBanner('已达到每周使用限额'))
  assert.ok(isLimitBanner('Approaching weekly usage limit'))
  assert.ok(isLimitBanner("You're close to your weekly limit"))
  // Other status bars and the usage button's text stay alone
  assert.ok(!isLimitBanner('用量：每周 · 所有模型：76%周日23:00 重置'))
  assert.ok(!isLimitBanner('Claude 正在回复'))
  assert.ok(!isLimitBanner('即将达到 5 小时使用限额'))
})

test('bannerDue waits for a high weekly figure, spaces checks, and rests after closing', () => {
  const now = 10 * 60 * 60 * 1000
  assert.strictEqual(bannerDue({ weeklyPercent: 40, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 69.9, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 76, now }), true)
  // Unknown use: look anyway
  assert.strictEqual(bannerDue({ weeklyPercent: null, now }), true)
  assert.strictEqual(bannerDue({ weeklyPercent: 80, checkedAt: now - 1000, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 80, checkedAt: now - 3000, now }), true)
  assert.strictEqual(bannerDue({ weeklyPercent: 80, dismissedAt: now - 10 * 60 * 1000, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 80, dismissedAt: now - 31 * 60 * 1000, now }), true)
})
