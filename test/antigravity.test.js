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
  readUsageFile,
  saveUsageFile,
  resolveActiveGroup,
  pickActiveModel,
  buildRendererPayload,
  parseJsonStdout,
  parseUsagePanelTexts,
  parseQuotaSummary,
  parseUserStatus,
  parseLanguageServerProcesses,
  parseHubDiscovery,
  readHubDiscoveryFiles,
  mergeDiscoveredServers,
  isLoginRequired,
} = require('../src/antigravity')
const { handleEvent } = require('../antigravity-plugin/scripts/hook')

test('classifyModel maps Gemini, Argon, Flash, Claude and GPT variants to expected groups', () => {
  assert.strictEqual(classifyModel('Gemini 4 Neon (High)'), 'gemini')
  assert.strictEqual(classifyModel('Gemini 4 Neon 高'), 'gemini')
  assert.strictEqual(classifyModel('gemini-4-neon-high'), 'gemini')
  assert.strictEqual(classifyModel('Gemini 3.8 Flash 中'), 'gemini')
  assert.strictEqual(classifyModel('Orchestrator (Neon)'), 'gemini')
  assert.strictEqual(classifyModel('Gemini 4 Argon (Medium)'), 'gemini_argon')
  assert.strictEqual(classifyModel('Gemini 4 Argon 中'), 'gemini_argon')
  assert.strictEqual(classifyModel('Orchestrator (Argon)'), 'gemini_argon')
  assert.strictEqual(classifyModel('Gemini 2.5 Pro'), 'gemini_pro')
  assert.strictEqual(classifyModel('Gemini 2.5 Flash'), 'gemini_flash')
  assert.strictEqual(classifyModel('Gemini Flash Lite'), 'gemini_flash')
  assert.strictEqual(classifyModel('Claude Sonnet 4.6'), 'claude')
  assert.strictEqual(classifyModel('Claude Opus 5.5 (High)'), 'claude')
  assert.strictEqual(classifyModel('GPT-OSS 120B (Medium)'), 'claude')
  assert.strictEqual(classifyModel('auto'), null)
  assert.strictEqual(classifyModel(''), null)
})

test('classifyBucket keeps generic gemini pool distinct and merges 3p/gpt into claude', () => {
  assert.strictEqual(classifyBucket('gemini-5h'), 'gemini')
  assert.strictEqual(classifyBucket('gemini-7d'), 'gemini')
  assert.strictEqual(classifyBucket('Gemini 4 Argon'), 'gemini_argon')
  assert.strictEqual(classifyBucket('gemini-pro-5h'), 'gemini_pro')
  assert.strictEqual(classifyBucket('gemini-flash-5h'), 'gemini_flash')
  assert.strictEqual(classifyBucket('3p-5h'), 'claude')
  assert.strictEqual(classifyBucket('gpt'), 'claude')
  assert.strictEqual(classifyBucket('claude-sonnet'), 'claude')
})

test('parseUsagePanelTexts parses Antigravity 2.0 usage panel texts into 5h and weekly limits', () => {
  const now = Date.parse('2026-11-20T18:40:00.000Z')
  const parsed = parseUsagePanelTexts(
    [
      '使用情况',
      'Gemini 模型',
      '每周限额',
      '70% 剩余',
      'Resets in 6d 20h',
      '5h limit',
      '0% 剩余',
      'Resets in 1h 16m',
      'Claude 与 GPT 模型',
      '每周限额',
      '48% 剩余',
      'Resets in 6d 23h',
      '5h limit',
      '0% 剩余',
      'Resets in 4h 47m',
      'Gemini 4 Argon',
      '71% 剩余',
      'Weekly limit, resets in 6d 21h',
    ],
    now,
  )
  assert.ok(parsed)
  assert.strictEqual(parsed.groups.length, 3)
  const gem = parsed.groups.find(g => g.id === 'gemini')
  const argon = parsed.groups.find(g => g.id === 'gemini_argon')
  const cla = parsed.groups.find(g => g.id === 'claude')
  assert.deepStrictEqual(
    gem.limits.map(l => ({ kind: l.kind, pct: l.percentUsed })),
    [
      { kind: 'five_hour', pct: 100 },
      { kind: 'seven_day', pct: 30 },
    ],
  )
  assert.deepStrictEqual(
    cla.limits.map(l => ({ kind: l.kind, pct: l.percentUsed })),
    [
      { kind: 'five_hour', pct: 100 },
      { kind: 'seven_day', pct: 52 },
    ],
  )
  assert.deepStrictEqual(
    argon.limits.map(l => ({ kind: l.kind, pct: l.percentUsed })),
    [{ kind: 'seven_day', pct: 29 }],
  )
  assert.strictEqual(resolveActiveGroup(parsed.groups, 'Gemini 4 Argon 中').id, 'gemini_argon')
  assert.strictEqual(resolveActiveGroup(parsed.groups, 'Gemini 4 Neon 中').id, 'gemini')
  assert.strictEqual(resolveActiveGroup(parsed.groups, 'Claude Opus 5.5 中').id, 'claude')
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
  const tp = normalized.groups.find(g => g.id === 'claude')
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
  assert.strictEqual(resolveActiveGroup(pooled, 'Claude Sonnet 4.6').id, 'claude')
  assert.strictEqual(resolveActiveGroup(pooled, 'GPT-5').id, 'claude')
  // Manual override wins over activeModel
  assert.strictEqual(resolveActiveGroup(pooled, 'Gemini 4 Neon (High)', 'claude').id, 'claude')

  const split = normalizeUsage({
    groups: [
      { id: 'gemini_pro', limits: [{ kind: 'five_hour', percentUsed: 40 }] },
      { id: 'gemini_flash', limits: [{ kind: 'five_hour', percentUsed: 10 }] },
      { id: 'claude', limits: [{ kind: 'five_hour', percentUsed: 80 }] },
    ],
  }).groups
  assert.strictEqual(resolveActiveGroup(split, 'Gemini 2.5 Flash').id, 'gemini_flash')
  assert.strictEqual(resolveActiveGroup(split, 'Gemini 2.5 Pro').id, 'gemini_pro')
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

test('mergeUsage drops removed groups from stale usage.json when native RPC is authoritative', () => {
  const staleFile = normalizeUsage({
    updatedAt: 1000,
    activeModel: 'gemini-4-neon-high',
    groups: [
      {
        id: 'gemini',
        limits: [
          { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-11-20T20:07:23.000Z' },
          { kind: 'seven_day', percentUsed: 30, resetsAt: '2026-11-27T14:51:23.000Z' },
        ],
      },
      {
        id: 'gemini_argon',
        limits: [{ kind: 'seven_day', percentUsed: 29, resetsAt: '2026-11-27T15:51:23.000Z' }],
      },
      {
        id: 'claude',
        limits: [{ kind: 'seven_day', percentUsed: 52, resetsAt: '2026-11-27T17:51:23.000Z' }],
      },
    ],
  })
  const liveNative = normalizeUsage({
    updatedAt: 2000,
    groups: [
      {
        id: 'gemini',
        limits: [
          { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-11-25T18:00:00.000Z' },
          { kind: 'seven_day', percentUsed: 36, resetsAt: '2026-12-01T15:30:00.000Z' },
        ],
      },
      {
        id: 'claude',
        limits: [
          { kind: 'five_hour', percentUsed: 0 },
          { kind: 'seven_day', percentUsed: 0 },
        ],
      },
    ],
  })

  // Non-authoritative fallback keeps groups present only in the file
  const fallbackMerged = mergeUsage(staleFile, liveNative)
  assert.deepStrictEqual(
    fallbackMerged.groups.map(g => g.id),
    ['gemini', 'gemini_argon', 'claude'],
  )

  // Authoritative native RPC drops stale groups and uses the live snapshot directly
  const authoritativeMerged = mergeUsage(staleFile, liveNative, { authoritative: true })
  assert.deepStrictEqual(
    authoritativeMerged.groups.map(g => g.id),
    ['gemini', 'claude'],
  )
  assert.strictEqual(authoritativeMerged.activeModel, 'gemini-4-neon-high')
  assert.strictEqual(authoritativeMerged.groups.find(g => g.id === 'gemini').limits[1].percentUsed, 36)
  assert.strictEqual(authoritativeMerged.groups.find(g => g.id === 'claude').limits[1].percentUsed, 0)

  // If the file is actually newer than the cached native snapshot, keep merging normally
  const newerFile = normalizeUsage({
    updatedAt: 3000,
    groups: [
      { id: 'gemini', limits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: '2026-12-01T15:30:00.000Z' }] },
      { id: 'gemini_argon', limits: [{ kind: 'seven_day', percentUsed: 12 }] },
    ],
  })
  const withNewerFile = mergeUsage(newerFile, liveNative, { authoritative: true })
  assert.deepStrictEqual(
    withNewerFile.groups.map(g => g.id),
    ['gemini', 'gemini_argon', 'claude'],
  )
  assert.strictEqual(withNewerFile.groups.find(g => g.id === 'gemini').limits[1].percentUsed, 40)
})

test('saveUsageFile overwrites stale cached groups atomically on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ag-usage-'))
  const file = path.join(dir, 'usage.json')
  try {
    saveUsageFile(
      normalizeUsage({
        updatedAt: 1000,
        groups: [
          { id: 'gemini', limits: [{ kind: 'seven_day', percentUsed: 30 }] },
          { id: 'gemini_argon', limits: [{ kind: 'seven_day', percentUsed: 29 }] },
        ],
      }),
      file,
    )
    assert.deepStrictEqual(
      readUsageFile(file).groups.map(g => g.id),
      ['gemini', 'gemini_argon'],
    )

    saveUsageFile(
      normalizeUsage({
        updatedAt: 2000,
        groups: [
          { id: 'gemini', limits: [{ kind: 'seven_day', percentUsed: 36 }] },
          { id: 'claude', limits: [{ kind: 'seven_day', percentUsed: 0 }] },
        ],
      }),
      file,
    )
    const reloaded = readUsageFile(file)
    assert.deepStrictEqual(
      reloaded.groups.map(g => g.id),
      ['gemini', 'claude'],
    )
    assert.strictEqual(reloaded.groups[0].limits[0].percentUsed, 36)
    assert.deepStrictEqual(fs.readdirSync(dir), ['usage.json'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isLoginRequired recognizes antigravity-usage not-logged-in output', () => {
  assert.ok(isLoginRequired(null, '', 'Unable to fetch quota: Antigravity is not running and you are not logged in.\nLogin with: antigravity-usage login'))
  assert.ok(!isLoginRequired(null, '', 'ETIMEDOUT'))
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

test('parseQuotaSummary reads Antigravity 2.0 weekly and 5-hour buckets for every group', () => {
  const now = Date.parse('2026-11-20T18:00:00.000Z')
  const parsed = parseQuotaSummary(
    {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description:
              'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 0.69737995,
                resetTime: '2026-11-27T14:56:20Z',
              },
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: 0.0037382,
                resetTime: '2026-11-20T19:56:20Z',
              },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
            buckets: [
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 0.483768,
                resetTime: '2026-11-27T18:26:45Z',
              },
              {
                bucketId: '3p-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: 0.0008,
                resetTime: '2026-11-20T23:26:45Z',
              },
            ],
          },
          {
            displayName: 'Gemini 4 Argon',
            description: 'Models within this group: Gemini 4 Argon',
            buckets: [
              {
                bucketId: 'gemini-argon-wtu-weekly',
                displayName: 'Gemini 4 Argon Weekly Limit',
                window: 'weekly',
                remainingFraction: 0.5544509,
                resetTime: '2026-11-27T16:24:17Z',
              },
            ],
          },
        ],
      },
    },
    now,
  )
  assert.ok(parsed)
  assert.deepStrictEqual(
    parsed.groups.map(g => g.id),
    ['gemini', 'gemini_argon', 'claude'],
  )
  const gem = parsed.groups[0]
  const argon = parsed.groups[1]
  const cla = parsed.groups[2]
  assert.ok(gem.models.includes('Gemini 4 Neon'))
  assert.deepStrictEqual(
    gem.limits.map(l => ({ kind: l.kind, pct: l.percentUsed, reset: l.resetsAt })),
    [
      { kind: 'five_hour', pct: 99.6, reset: '2026-11-20T19:56:20.000Z' },
      { kind: 'seven_day', pct: 30.3, reset: '2026-11-27T14:56:20.000Z' },
    ],
  )
  assert.deepStrictEqual(
    cla.limits.map(l => ({ kind: l.kind, pct: l.percentUsed })),
    [
      { kind: 'five_hour', pct: 99.9 },
      { kind: 'seven_day', pct: 51.6 },
    ],
  )
  assert.deepStrictEqual(
    argon.limits.map(l => ({ kind: l.kind, pct: l.percentUsed })),
    [{ kind: 'seven_day', pct: 44.6 }],
  )
  assert.strictEqual(resolveActiveGroup(parsed.groups, 'Gemini 4 Argon 中').id, 'gemini_argon')
  assert.strictEqual(resolveActiveGroup(parsed.groups, 'Claude Opus 5.5 中').id, 'claude')
  assert.strictEqual(resolveActiveGroup(parsed.groups, 'GPT-OSS 120B').id, 'claude')
})

test('parseQuotaSummary accepts snake_case buckets and skips disabled ones', () => {
  const parsed = parseQuotaSummary({
    groups: [
      {
        display_name: 'Gemini Models',
        buckets: [
          { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-27T14:56:20Z' },
          { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.25, disabled: true },
        ],
      },
    ],
  })
  assert.ok(parsed)
  assert.deepStrictEqual(
    parsed.groups[0].limits.map(l => ({ kind: l.kind, pct: l.percentUsed })),
    [{ kind: 'seven_day', pct: 50 }],
  )
})

test('parseUserStatus falls back to per-model remainingFraction snapshots', () => {
  const now = Date.parse('2026-11-20T18:00:00.000Z')
  const parsed = parseUserStatus(
    {
      response: {
        userStatus: {
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 4 Neon (High)',
                modelId: 'gemini-4-neon-high',
                quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-20T22:00:00Z' },
              },
              {
                label: 'Claude Opus 5.5',
                modelId: 'claude-opus-5-5',
                quotaInfo: { remainingFraction: 0.4, resetTime: '2026-11-20T23:00:00Z' },
              },
              {
                label: 'Gemini 2.5 Flash Autocomplete',
                modelId: 'gemini-2.5-flash',
                quotaInfo: { remainingFraction: 0.1 },
              },
            ],
          },
        },
      },
    },
    now,
  )
  assert.ok(parsed)
  assert.strictEqual(parsed.groups.length, 2)
  assert.strictEqual(parsed.groups.find(g => g.id === 'gemini').limits[0].percentUsed, 20)
  assert.strictEqual(parsed.groups.find(g => g.id === 'claude').limits[0].percentUsed, 60)
  assert.strictEqual(parseUserStatus({ response: { userStatus: {} } }), null)
})

test('parseLanguageServerProcesses reads pid, csrf token and listening ports from discovery JSON', () => {
  const single = parseLanguageServerProcesses(
    JSON.stringify({ pid: 14648, token: 'd0ad9d01-bba9-428e-8e07-2f159e0c322f', ports: [2556, 2557, 4153] }),
  )
  assert.deepStrictEqual(single, [
    { pid: 14648, token: 'd0ad9d01-bba9-428e-8e07-2f159e0c322f', ports: [2556, 2557, 4153] },
  ])
  assert.deepStrictEqual(
    parseLanguageServerProcesses(
      '\uFEFF' +
        JSON.stringify([
          { pid: 1, token: 'abc', ports: [2556, 2556, 0, 70000] },
          { pid: 2, token: '', ports: [2557] },
          null,
        ]),
    ),
    [{ pid: 1, token: 'abc', ports: [2556] }],
  )
  assert.deepStrictEqual(parseLanguageServerProcesses('[]'), [])
  assert.deepStrictEqual(parseLanguageServerProcesses('not json'), [])
  assert.deepStrictEqual(
    parseLanguageServerProcesses(JSON.stringify([{ pid: 2, token: '', ports: [2557] }]), { requireToken: false }),
    [{ pid: 2, token: '', ports: [2557] }],
  )
})

test('parseHubDiscovery reads Antigravity 2.34 hub discovery files', () => {
  const token = '11111111-2222-4333-8444-555555555555'
  assert.deepStrictEqual(
    parseHubDiscovery(
      { pid: 39872, httpsPort: 3248, httpPort: 3249, lsVersion: '2.34.0', csrfToken: token },
      'hub_3249.json',
    ),
    { pid: 39872, token, ports: [3248, 3249] },
  )
  assert.deepStrictEqual(
    parseHubDiscovery({ pid: 1, csrf_token: 'abc', https_port: 2556, http_port: 2557 }, 'notes.txt'),
    { pid: 1, token: 'abc', ports: [2556, 2557] },
  )
  assert.strictEqual(parseHubDiscovery({ pid: 0, csrfToken: token, httpPort: 1 }), null)
  assert.strictEqual(parseHubDiscovery({ pid: 1, csrfToken: '', httpPort: 1 }), null)
})

test('readHubDiscoveryFiles ignores stale or malformed files and prefers the newest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-hub-'))
  const token = '11111111-2222-4333-8444-555555555555'
  try {
    const now = Date.now()
    fs.writeFileSync(
      path.join(dir, 'hub_3249.json'),
      JSON.stringify({ pid: process.pid, httpsPort: 3248, httpPort: 3249, csrfToken: token }),
    )
    fs.writeFileSync(
      path.join(dir, 'hub_3248.json'),
      JSON.stringify({ pid: process.pid, httpPort: 3248, csrfToken: 'older-token' }),
    )
    fs.writeFileSync(
      path.join(dir, 'hub_2557.json'),
      JSON.stringify({ pid: 2147483647, httpPort: 2557, csrfToken: 'stale-token' }),
    )
    fs.writeFileSync(path.join(dir, 'hub_9999.json'), '{broken')
    fs.writeFileSync(path.join(dir, 'notes.txt'), JSON.stringify({ pid: process.pid, httpPort: 1, csrfToken: 'x' }))
    fs.utimesSync(path.join(dir, 'hub_3248.json'), new Date(now - 1000), new Date(now - 1000))
    fs.utimesSync(path.join(dir, 'hub_3249.json'), new Date(now), new Date(now))
    const found = readHubDiscoveryFiles(dir).map(({ updatedAt, ...entry }) => entry)
    assert.deepStrictEqual(found, [
      { pid: process.pid, token, ports: [3248, 3249] },
      { pid: process.pid, token: 'older-token', ports: [3248] },
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeDiscoveredServers keeps process ports and takes the hub CSRF token', () => {
  assert.deepStrictEqual(
    mergeDiscoveredServers(
      [
        { pid: 39872, token: '', ports: [3248, 2040, 3249] },
        { pid: 1, token: 'legacy', ports: [2557] },
      ],
      [{ pid: 39872, token: 'hub-token', ports: [3249, 3248] }],
    ),
    [
      { pid: 39872, token: 'hub-token', ports: [2040, 3248, 3249] },
      { pid: 1, token: 'legacy', ports: [2557] },
    ],
  )
})

test('pickActiveModel prefers whichever of UIA or hook observed the latest model change', () => {
  assert.strictEqual(
    pickActiveModel({ uiModel: 'Claude Opus 5.5 中', uiModelAt: 2000, hookModel: 'gemini-4-argon-medium', hookUpdatedAt: 1000 }),
    'Claude Opus 5.5 中',
  )
  assert.strictEqual(
    pickActiveModel({ uiModel: 'Gemini 4 Neon 高', uiModelAt: 1000, hookModel: 'gemini-4-argon-medium', hookUpdatedAt: 2000 }),
    'gemini-4-argon-medium',
  )
  assert.strictEqual(
    pickActiveModel({ uiModel: 'Gemini 4 Neon 高', uiModelAt: 2000, hookModel: 'gemini-4-argon-medium', hookUpdatedAt: 2000 }),
    'Gemini 4 Neon 高',
  )
  assert.strictEqual(pickActiveModel({ uiModel: null, hookModel: 'gemini-4-argon-medium', hookUpdatedAt: 1000 }), 'gemini-4-argon-medium')
  assert.strictEqual(pickActiveModel({ usageModel: 'Gemini 3.8 Flash' }), 'Gemini 3.8 Flash')
  assert.strictEqual(pickActiveModel({}), null)
})
