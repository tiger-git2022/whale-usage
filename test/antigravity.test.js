const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  classifyModel,
  classifyBucket,
  normalizeUsage,
  mergeUsage,
  resolveActiveGroup,
  buildRendererPayload,
  parseJsonStdout,
} = require('../src/antigravity')
const { handleEvent } = require('../antigravity-plugin/scripts/hook')

test('classifyModel maps Gemini, Flash, Claude and GPT variants to expected groups', () => {
  assert.strictEqual(classifyModel('Gemini 4 Neon (High)'), 'gemini_pro')
  assert.strictEqual(classifyModel('Gemini 2.5 Pro'), 'gemini_pro')
  assert.strictEqual(classifyModel('Gemini 2.5 Flash'), 'gemini_flash')
  assert.strictEqual(classifyModel('Gemini Flash Lite'), 'gemini_flash')
  assert.strictEqual(classifyModel('Claude Sonnet 4.6'), 'claude')
  assert.strictEqual(classifyModel('Claude Opus 4.6 (Thinking)'), 'claude')
  assert.strictEqual(classifyModel('GPT-OSS 120B'), 'gpt')
  assert.strictEqual(classifyModel('auto'), null)
  assert.strictEqual(classifyModel(''), null)
})

test('classifyBucket keeps generic gemini pool distinct from pro/flash', () => {
  assert.strictEqual(classifyBucket('gemini-5h'), 'gemini')
  assert.strictEqual(classifyBucket('gemini-7d'), 'gemini')
  assert.strictEqual(classifyBucket('gemini-pro-5h'), 'gemini_pro')
  assert.strictEqual(classifyBucket('gemini-flash-5h'), 'gemini_flash')
  assert.strictEqual(classifyBucket('3p-5h'), 'third_party')
  assert.strictEqual(classifyBucket('claude-sonnet'), 'claude')
})

test('normalizeUsage reads antigravity-usage 0.2.x models snapshot with remainingPercentage and isExhausted', () => {
  const now = Date.parse('2026-11-20T17:00:00.000Z')
  const normalized = normalizeUsage(
    {
      timestamp: '2026-11-20T17:00:00.000Z',
      method: 'local',
      models: [
        {
          label: 'Gemini 3 Pro (High)',
          modelId: 'gemini-3-pro-high',
          remainingPercentage: 0.85,
          isExhausted: false,
          resetTime: '2026-11-20T22:00:00.000Z',
          isAutocompleteOnly: false,
        },
        {
          label: 'Gemini 3 Flash',
          modelId: 'gemini-3-flash',
          remainingPercentage: 0.92,
          isExhausted: false,
          timeUntilResetMs: 3600 * 1000,
          isAutocompleteOnly: false,
        },
        {
          label: 'Claude Sonnet 4.5',
          modelId: 'claude-sonnet-4-5',
          remainingPercentage: 0,
          isExhausted: true,
          resetTime: '2026-11-20T20:00:00.000Z',
          isAutocompleteOnly: false,
        },
        {
          label: 'Gemini 2.5 Flash Autocomplete',
          modelId: 'gemini-2.5-flash-002',
          remainingPercentage: 0.5,
          isAutocompleteOnly: true,
        },
      ],
    },
    now,
  )
  assert.ok(normalized)
  assert.strictEqual(normalized.groups.length, 3)
  const pro = normalized.groups.find(g => g.id === 'gemini_pro')
  const flash = normalized.groups.find(g => g.id === 'gemini_flash')
  const claude = normalized.groups.find(g => g.id === 'claude')
  assert.strictEqual(pro.limits[0].percentUsed, 15)
  assert.strictEqual(flash.limits[0].percentUsed, 8)
  assert.strictEqual(flash.limits[0].resetsAt, '2026-11-20T18:00:00.000Z')
  assert.strictEqual(claude.limits[0].percentUsed, 100)
  assert.strictEqual(resolveActiveGroup(normalized.groups, 'Gemini 3 Pro (High)').id, 'gemini_pro')
  assert.strictEqual(resolveActiveGroup(normalized.groups, 'Claude Sonnet 4.5').id, 'claude')
})

test('normalizeUsage converts antigravity-usage --json remainingFraction to percentUsed', () => {
  const normalized = normalizeUsage({
    account: 'user@example.com',
    timestamp: '2026-11-20T16:40:00Z',
    quotas: [
      { model: 'gemini-5h', remainingFraction: 0.85, resetTime: '2026-11-20T21:15:30Z' },
      { model: '3p-5h', remainingFraction: 0.4, resetTime: '2026-11-20T19:00:00Z' },
      { model: '3p-7d', remainingFraction: 0.72, resetTime: '2026-11-27T00:00:00Z' },
    ],
  })
  assert.ok(normalized)
  assert.strictEqual(normalized.groups.length, 2)
  const gem = normalized.groups.find(g => g.id === 'gemini')
  const tp = normalized.groups.find(g => g.id === 'third_party')
  assert.strictEqual(gem.limits[0].kind, 'five_hour')
  assert.strictEqual(gem.limits[0].percentUsed, 15)
  assert.strictEqual(tp.limits.length, 2)
  assert.strictEqual(tp.limits[0].kind, 'five_hour')
  assert.strictEqual(tp.limits[0].percentUsed, 60)
  assert.strictEqual(tp.limits[1].kind, 'seven_day')
  assert.strictEqual(tp.limits[1].percentUsed, 28)
})

test('normalizeUsage reads standard multi-group usage.json with percentUsed and remainingPercent', () => {
  const normalized = normalizeUsage({
    updatedAt: 1760000000000,
    activeModel: 'Claude Sonnet 4.6',
    groups: [
      {
        id: 'gemini_pro',
        label: 'Gemini Pro',
        limits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: '2026-11-21T05:00:00.000Z' }],
      },
      {
        id: 'claude',
        label: 'Claude',
        limits: [{ kind: 'five_hour', remainingPercent: 30, resetsAt: '2026-11-21T04:00:00.000Z' }],
      },
    ],
  })
  assert.strictEqual(normalized.activeModel, 'Claude Sonnet 4.6')
  assert.strictEqual(normalized.groups[0].id, 'gemini_pro')
  assert.strictEqual(normalized.groups[0].limits[0].percentUsed, 25)
  assert.strictEqual(normalized.groups[1].id, 'claude')
  assert.strictEqual(normalized.groups[1].limits[0].percentUsed, 70)
})

test('resolveActiveGroup selects matching pool and falls back cleanly across granularities', () => {
  const pooled = normalizeUsage({
    quotas: [
      { model: 'gemini-5h', remainingFraction: 0.9, resetTime: '2026-11-20T21:00:00Z' },
      { model: '3p-5h', remainingFraction: 0.5, resetTime: '2026-11-20T20:00:00Z' },
    ],
  }).groups

  assert.strictEqual(resolveActiveGroup(pooled, 'Gemini 4 Neon (High)').id, 'gemini')
  assert.strictEqual(resolveActiveGroup(pooled, 'Gemini 2.5 Flash').id, 'gemini')
  assert.strictEqual(resolveActiveGroup(pooled, 'Claude Sonnet 4.6').id, 'third_party')
  assert.strictEqual(resolveActiveGroup(pooled, 'GPT-5').id, 'third_party')
  // Manual override wins over activeModel
  assert.strictEqual(resolveActiveGroup(pooled, 'Gemini 4 Neon (High)', 'third_party').id, 'third_party')

  const split = normalizeUsage({
    groups: [
      { id: 'gemini_pro', limits: [{ kind: 'five_hour', percentUsed: 40 }] },
      { id: 'gemini_flash', limits: [{ kind: 'five_hour', percentUsed: 10 }] },
      { id: 'claude', limits: [{ kind: 'five_hour', percentUsed: 80 }] },
    ],
  }).groups
  assert.strictEqual(resolveActiveGroup(split, 'Gemini 2.5 Flash').id, 'gemini_flash')
  assert.strictEqual(resolveActiveGroup(split, 'Gemini 4 Neon (High)').id, 'gemini_pro')
  assert.strictEqual(resolveActiveGroup(split, 'Claude Opus 4.6').id, 'claude')
})

test('buildRendererPayload puts active group first and exposes its limits for pet pills', () => {
  const usage = normalizeUsage({
    groups: [
      { id: 'gemini_pro', limits: [{ kind: 'five_hour', percentUsed: 18 }] },
      { id: 'claude', limits: [{ kind: 'five_hour', percentUsed: 74 }] },
    ],
  })
  const payload = buildRendererPayload({ usage, activeModel: 'Claude Sonnet 4.6' })
  assert.strictEqual(payload.host, 'antigravity')
  assert.strictEqual(payload.activeGroup, 'claude')
  assert.strictEqual(payload.groups[0].id, 'claude')
  assert.strictEqual(payload.groups[0].active, true)
  assert.strictEqual(payload.groups[1].active, false)
  assert.strictEqual(payload.limits.length, 1)
  assert.strictEqual(payload.limits[0].percentUsed, 74)
  assert.strictEqual(payload.limits[0].shortLabel, 'Cla')
})

test('mergeUsage keeps higher percent within the same window and newer reading after reset', () => {
  const file = normalizeUsage({
    updatedAt: 1000,
    groups: [{ id: 'gemini', limits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-11-21T05:00:00.000Z' }] }],
  })
  const cliSame = normalizeUsage({
    updatedAt: 2000,
    groups: [
      { id: 'gemini', limits: [{ kind: 'five_hour', percentUsed: 25, resetsAt: '2026-11-21T05:00:10.000Z' }] },
      { id: 'claude', limits: [{ kind: 'five_hour', percentUsed: 50, resetsAt: '2026-11-21T06:00:00.000Z' }] },
    ],
  })
  const merged = mergeUsage(file, cliSame)
  assert.strictEqual(merged.groups.find(g => g.id === 'gemini').limits[0].percentUsed, 30)
  assert.strictEqual(merged.groups.find(g => g.id === 'claude').limits[0].percentUsed, 50)

  const cliReset = normalizeUsage({
    updatedAt: 3000,
    groups: [{ id: 'gemini', limits: [{ kind: 'five_hour', percentUsed: 5, resetsAt: '2026-11-21T10:00:00.000Z' }] }],
  })
  assert.strictEqual(mergeUsage(file, cliReset).groups.find(g => g.id === 'gemini').limits[0].percentUsed, 5)
})

test('parseJsonStdout tolerates leading warnings and ANSI escapes', () => {
  const parsed = parseJsonStdout('\x1b[33mWarning: cache stale\x1b[0m\n{"quotas":[{"model":"gemini-5h","remainingFraction":0.8}]}')
  assert.strictEqual(parsed.quotas.length, 1)
})

test('antigravity hook script writes active model, wait state, and turn deltas', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ag-hook-'))
  const prevEnv = process.env.ANTIGRAVITY_WHALE_DIR
  process.env.ANTIGRAVITY_WHALE_DIR = tmp
  try {
    fs.writeFileSync(
      path.join(tmp, 'usage.json'),
      JSON.stringify({
        updatedAt: 1000,
        groups: [{ id: 'gemini_pro', limits: [{ kind: 'five_hour', percentUsed: 20 }] }],
      }),
    )

    handleEvent({ hookEventName: 'SessionStart', conversationId: 'conv-1', modelName: 'Gemini 4 Neon (High)' }, 1000)
    const st = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'))
    assert.strictEqual(st.modelName, 'Gemini 4 Neon (High)')

    handleEvent({ hookEventName: 'PreInvocation', conversationId: 'conv-1', modelName: 'Gemini 4 Neon (High)', invocationNum: 1 }, 1100)
    const preResp = handleEvent(
      { hookEventName: 'PreToolUse', conversationId: 'conv-1', toolCall: { name: 'ask_question' } },
      1200,
    )
    assert.deepStrictEqual(preResp, { decision: 'allow' })
    let sess = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'conv-1.json'), 'utf8'))
    assert.strictEqual(sess.wait.kind, 'question')
    assert.strictEqual(sess.host, 'antigravity')

    handleEvent({ hookEventName: 'PostToolUse', conversationId: 'conv-1', toolCall: { name: 'ask_question' } }, 1300)
    sess = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'conv-1.json'), 'utf8'))
    assert.strictEqual(sess.wait, null)

    fs.writeFileSync(
      path.join(tmp, 'usage.json'),
      JSON.stringify({
        updatedAt: 1400,
        groups: [{ id: 'gemini_pro', limits: [{ kind: 'five_hour', percentUsed: 23 }] }],
      }),
    )
    handleEvent(
      {
        hookEventName: 'Stop',
        conversationId: 'conv-1',
        modelName: 'Gemini 4 Neon (High)',
        terminationReason: 'NO_TOOL_CALL',
        executionNum: 1,
      },
      1500,
    )
    sess = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'conv-1.json'), 'utf8'))
    assert.strictEqual(sess.turn.deltas['gemini_pro:five_hour'], 3)
  } finally {
    if (prevEnv === undefined) delete process.env.ANTIGRAVITY_WHALE_DIR
    else process.env.ANTIGRAVITY_WHALE_DIR = prevEnv
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
