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

test('bannerDue waits for a high weekly figure, spaces checks, and waits for more use after closing', () => {
  const now = 10 * 60 * 60 * 1000
  assert.strictEqual(bannerDue({ weeklyPercent: 40, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 69.9, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 76, now }), true)
  // Unknown use: look anyway
  assert.strictEqual(bannerDue({ weeklyPercent: null, now }), true)
  assert.strictEqual(bannerDue({ weeklyPercent: 80, checkedAt: now - 1000, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 80, checkedAt: now - 3000, now }), true)
  // Closed at 76%: quiet until 79%, however long it takes
  const dismissed = { at: now - 5 * 60 * 60 * 1000, weeklyPercent: 76 }
  assert.strictEqual(bannerDue({ weeklyPercent: 78.9, dismissed, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: 79, dismissed, now }), true)
  // The week started over and climbed back: look again
  assert.strictEqual(bannerDue({ weeklyPercent: 72, dismissed, now }), true)
  // Use not known: a half-hour rest instead
  assert.strictEqual(bannerDue({ weeklyPercent: null, dismissed: { at: now - 10 * 60 * 1000, weeklyPercent: 76 }, now }), false)
  assert.strictEqual(bannerDue({ weeklyPercent: null, dismissed: { at: now - 31 * 60 * 1000, weeklyPercent: 76 }, now }), true)
})

test('fitToWindow maps a box Windows scaled back onto the real window', () => {
  const { fitToWindow } = require('../src/composer')
  const real = { left: -8, top: -8, right: 2568, bottom: 1400 }
  const box = { left: 100, top: 1200, right: 2400, bottom: 1300 }
  // Same size: left alone
  assert.strictEqual(fitToWindow(box, real, real), box)
  assert.strictEqual(fitToWindow(box, null, real), box)
  // The reader still thinks the display is at 100% while it is at 175%
  const k = 1 / 1.75
  const s = r => ({ left: r.left * k, top: r.top * k, right: r.right * k, bottom: r.bottom * k })
  const fitted = fitToWindow(s(box), s(real), real)
  for (const side of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(fitted[side] - box[side]) <= 1, side)
  // The window is being resized: the answer is a moment behind, so sizes differ, but nothing is scaled
  const widened = { ...real, right: real.right + 300 }
  assert.strictEqual(fitToWindow(box, real, widened), box)
  const nudged = { ...real, right: real.right + 20, bottom: real.bottom + 10 }
  assert.strictEqual(fitToWindow(box, real, nudged), box)
})
