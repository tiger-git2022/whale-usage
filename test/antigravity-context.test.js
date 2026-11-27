const test = require('node:test')
const assert = require('node:assert')
const {
  inferContextLimit,
  resolveModelLabel,
  parseModelCatalog,
  parseTrajectories,
  parseConversationSummary,
  parseConversationList,
  mergeTaskSummaries,
  parseGeneratorMetadataContext,
  parseStepsContext,
  matchTaskByTitles,
  resolveActiveTask,
  createContextReader,
} = require('../src/antigravity-context')
const { buildRendererPayload, normalizeUsage } = require('../src/antigravity')

test('inferContextLimit prefers live truncation threshold and falls back to model family defaults', () => {
  assert.strictEqual(inferContextLimit('MODEL_PLACEHOLDER_M532', 512000), 512000)
  assert.strictEqual(inferContextLimit('MODEL_PLACEHOLDER_M532', '200000'), 200000)
  assert.strictEqual(inferContextLimit('MODEL_PLACEHOLDER_M532', 0), 512000)
  assert.strictEqual(inferContextLimit('MODEL_PLACEHOLDER_M402', 0), 256000)
  assert.strictEqual(inferContextLimit('MODEL_PLACEHOLDER_M35', 0), 160000)
  assert.strictEqual(inferContextLimit('MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 0), 80000)
  assert.strictEqual(inferContextLimit('custom-gemini-4-future', 0), 512000)
  assert.strictEqual(inferContextLimit('unknown-model-id', 0), 256000)
})

test('parseModelCatalog maps placeholders and aliases to human-readable labels', () => {
  const names = parseModelCatalog(
    {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' } },
            { label: 'Claude Opus 5.5 (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M401' } },
          ],
        },
      },
    },
    {
      response: {
        models: {
          'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', model: 'MODEL_PLACEHOLDER_M417' },
        },
      },
    },
  )
  assert.strictEqual(resolveModelLabel('MODEL_PLACEHOLDER_M532', names), 'Gemini 4 Neon (High)')
  assert.strictEqual(resolveModelLabel('MODEL_PLACEHOLDER_M401', names), 'Claude Opus 5.5 (Medium)')
  assert.strictEqual(resolveModelLabel('gemini-4-argon-high', names), 'Gemini 4 Argon (High)')
  assert.strictEqual(resolveModelLabel('MODEL_PLACEHOLDER_M417', names), 'Gemini 4 Argon (High)')
  assert.strictEqual(resolveModelLabel('MODEL_UNSPECIFIED', names), '')
})

test('parseTrajectories sorts running tasks first, skips killed, and flags subagents', () => {
  const tasks = parseTrajectories({
    trajectorySummaries: {
      'idle-old': {
        summary: 'Old task',
        stepCount: 12,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-25T01:00:00Z',
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/AI%E5%BA%94%E7%94%A8/Claude%20Whale/' }],
      },
      'running-task': {
        summary: 'Active coding task',
        stepCount: 44,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastModifiedTime: '2026-11-25T02:00:00Z',
        latestTaskBoundaryStep: {
          step: { metadata: { requestedModel: { model: 'MODEL_PLACEHOLDER_M532' } } },
        },
      },
      'child-worker': {
        summary: 'Research helper',
        stepCount: 8,
        status: 'CASCADE_RUN_STATUS_IDLE',
        parentCascadeId: 'running-task',
        lastModifiedTime: '2026-11-25T03:00:00Z',
      },
      'killed-task': {
        summary: 'Removed task',
        stepCount: 5,
        status: 'CASCADE_RUN_STATUS_IDLE',
        killed: true,
        lastModifiedTime: '2026-11-25T04:00:00Z',
      },
      'untitled-id': {
        summary: '',
        stepCount: 2,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-25T02:30:00Z',
      },
    },
  })

  assert.deepStrictEqual(
    tasks.map(t => t.cascadeId),
    ['running-task', 'child-worker', 'untitled-id', 'idle-old'],
  )
  assert.strictEqual(tasks[0].isRunning, true)
  assert.strictEqual(tasks[0].model, 'MODEL_PLACEHOLDER_M532')
  assert.strictEqual(tasks[1].isSubagent, true)
  assert.strictEqual(tasks[2].isUntitled, true)
  assert.match(tasks[2].title, /未命名任务/)
  assert.strictEqual(tasks[3].workspace, 'Claude Whale')
})

test('parseGeneratorMetadataContext computes measured context usage, live limit, and breakdown', () => {
  const ctx = parseGeneratorMetadataContext({
    generatorMetadata: [
      {
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M532',
          usage: {
            model: 'MODEL_PLACEHOLDER_M532',
            inputTokens: '3280',
            cacheReadTokens: '170390',
            outputTokens: '701',
          },
          chatStartMetadata: {
            contextWindowMetadata: {
              estimatedTokensUsed: 165095,
              maxContextTokens: 512000,
              tokenBreakdown: {
                groups: [
                  { name: 'System Prompt', numTokens: 3820 },
                  { name: 'Chat Messages', numTokens: 138319 },
                  { name: 'Tools', numTokens: 9766 },
                ],
              },
            },
          },
        },
      },
    ],
  })

  assert.ok(ctx)
  assert.strictEqual(ctx.contextUsed, 174371)
  assert.strictEqual(ctx.contextLimit, 512000)
  assert.strictEqual(ctx.usagePercent, 34.1)
  assert.strictEqual(ctx.isEstimated, false)
  assert.strictEqual(ctx.modelLabel, 'Gemini 4 Neon (High)')
  assert.deepStrictEqual(
    ctx.breakdown.map(b => b.name),
    ['Chat Messages', 'Tools', 'System Prompt'],
  )
})

test('parseGeneratorMetadataContext falls back to estimatedTokensUsed and plannerConfig truncationThresholdTokens', () => {
  const ctx = parseGeneratorMetadataContext({
    generatorMetadata: [
      {
        plannerConfig: { truncationThresholdTokens: 160000 },
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M35',
          chatStartMetadata: {
            contextWindowMetadata: { estimatedTokensUsed: 40000 },
          },
        },
      },
    ],
  })
  assert.ok(ctx)
  assert.strictEqual(ctx.contextUsed, 40000)
  assert.strictEqual(ctx.contextLimit, 160000)
  assert.strictEqual(ctx.usagePercent, 25)
  assert.strictEqual(ctx.isEstimated, true)
})

test('parseStepsContext extracts latest planner modelUsage when GM is unavailable', () => {
  const ctx = parseStepsContext({
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        userInput: { userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M402' } } },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        metadata: {
          modelUsage: {
            model: 'MODEL_PLACEHOLDER_M402',
            inputTokens: '12000',
            cacheReadTokens: '100000',
            cacheCreationTokens: '16000',
            outputTokens: '2000',
          },
        },
      },
    ],
  })
  assert.ok(ctx)
  assert.strictEqual(ctx.contextUsed, 130000)
  assert.strictEqual(ctx.contextLimit, 256000)
  assert.strictEqual(ctx.usagePercent, 50.8)
  assert.strictEqual(ctx.modelLabel, 'Claude Opus 5.5 (High)')
})

test('resolveActiveTask follows pinned > UI conversation ID > UI title > hook > running main > latest main', () => {
  const list = [
    { cascadeId: 'sub-run', title: 'Helper', isRunning: true, isSubagent: true },
    { cascadeId: 'main-run', title: 'Anti-Gravity Context Switching Bug', isRunning: true, isSubagent: false },
    { cascadeId: 'main-idle', title: 'TranslateTB显示器断开报错修复', isRunning: false, isSubagent: false },
  ]
  assert.strictEqual(
    resolveActiveTask(list, { pinnedTaskId: 'main-idle', uiConversationId: 'main-run', hookConversationId: 'main-run' }).cascadeId,
    'main-idle',
  )
  // Switching to an idle conversation in UI overrides a running conversation and hook state.
  assert.strictEqual(
    resolveActiveTask(list, { uiConversationId: 'main-idle', hookConversationId: 'main-run' }).cascadeId,
    'main-idle',
  )
  // Switching to an unloaded conversation ID does not fall back to a stale conversation.
  assert.strictEqual(resolveActiveTask(list, { uiConversationId: 'not-loaded-yet', hookConversationId: 'main-run' }), null)
  // Title fallback matches exact or truncated titles when Document URL has no UUID.
  assert.strictEqual(
    resolveActiveTask(list, { uiConversationTitles: ['TranslateTB显示器断开报错修复'], hookConversationId: 'main-run' }).cascadeId,
    'main-idle',
  )
  assert.strictEqual(
    resolveActiveTask(list, { uiConversationTitles: ['Anti-Gravity Context Swit…'] }).cascadeId,
    'main-run',
  )
  assert.strictEqual(resolveActiveTask(list, { hookConversationId: 'main-idle' }).cascadeId, 'main-idle')
  assert.strictEqual(resolveActiveTask(list, {}).cascadeId, 'main-run')
  assert.strictEqual(
    resolveActiveTask(
      [
        { cascadeId: 'sub-run', title: 'Helper', isRunning: true, isSubagent: true },
        { cascadeId: 'main-idle', title: 'Idle', isRunning: false, isSubagent: false },
      ],
      {},
    ).cascadeId,
    'main-idle',
  )
})

test('parseConversationList and mergeTaskSummaries merge historical chats without overwriting trajectory metadata', () => {
  const trajectories = parseTrajectories({
    trajectorySummaries: {
      c1: {
        summary: 'Current chat',
        stepCount: 25,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastModifiedTime: '2026-11-27T08:00:00Z',
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/Claude%20Whale/' }],
      },
    },
  })
  const convs = parseConversationList({
    conversations: [
      {
        id: 'c1',
        annotations: { title: 'Current chat' },
        state: { runState: 'RUN_STATE_RUNNING', updateTime: '2026-11-27T08:00:00Z' },
      },
      {
        id: 'c2',
        annotations: { title: 'Older chat' },
        state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-27T06:00:00Z' },
      },
      {
        id: 'c-archived',
        annotations: { title: 'Archived chat', archived: true },
        state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-27T07:00:00Z' },
      },
    ],
  })
  assert.strictEqual(convs.length, 2)
  const merged = mergeTaskSummaries(trajectories, convs)
  assert.deepStrictEqual(
    merged.map(t => t.cascadeId),
    ['c1', 'c2'],
  )
  assert.strictEqual(merged[0].stepCount, 25)
  assert.strictEqual(merged[0].workspace, 'Claude Whale')
  assert.strictEqual(merged[1].title, 'Older chat')
})

test('matchTaskByTitles ignores untitled tasks and very short ambiguous fragments', () => {
  const list = [
    { cascadeId: 'a', title: '未命名任务 (aaaaaaaa)', isUntitled: true, isSubagent: false },
    { cascadeId: 'b', title: 'Windhawk And QTTabBar Conflict', isUntitled: false, isSubagent: false },
  ]
  assert.strictEqual(matchTaskByTitles(list, ['Wind']), null)
  assert.strictEqual(matchTaskByTitles(list, ['未命名任务 (aaaaaaaa)']), null)
  assert.strictEqual(matchTaskByTitles(list, ['windhawk and qttabbar conflict']).cascadeId, 'b')
  assert.strictEqual(matchTaskByTitles(list, ['Windhawk And QTTab...']).cascadeId, 'b')
})

test('createContextReader loads focused historical conversation via GetConversation even outside trajectories', async () => {
  const reader = createContextReader({
    discoverServers: async () => [{ pid: 1, token: 'tok', ports: [5000] }],
    requestJson: async ({ rpcPath, body }) => {
      const parsed = JSON.parse(body || '{}')
      if (rpcPath.endsWith('/GetAllCascadeTrajectories')) {
        return {
          trajectorySummaries: {
            t1: {
              summary: 'Recent chat',
              stepCount: 10,
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: '2026-11-27T08:00:00Z',
            },
          },
        }
      }
      if (rpcPath.endsWith('/ListConversations')) {
        return { conversations: [] }
      }
      if (rpcPath.endsWith('/GetConversation') && parsed.conversationId === 'old-hist-id') {
        return {
          id: 'old-hist-id',
          annotations: { title: 'Historical Chat' },
          state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-20T05:00:00Z' },
        }
      }
      if (rpcPath.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
        const tokens = parsed.cascadeId === 'old-hist-id' ? '128000' : '25600'
        return {
          generatorMetadata: [
            {
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M532',
                usage: { model: 'MODEL_PLACEHOLDER_M532', inputTokens: tokens, outputTokens: '0' },
                chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } },
              },
            },
          ],
        }
      }
      return null
    },
  })

  const res = await reader.readTasks({ focusedTaskId: 'old-hist-id', now: 1000 })
  assert.strictEqual(res.ok, true)
  const hist = res.tasks.find(t => t.cascadeId === 'old-hist-id')
  assert.ok(hist)
  assert.strictEqual(hist.title, 'Historical Chat')
  assert.strictEqual(hist.usagePercent, 25)
  assert.strictEqual(parseConversationSummary({ id: 'x', state: { summary: 'Fallback summary' } }).title, 'Fallback summary')
})

test('createContextReader caches unchanged tasks by stepCount+mtime and falls back to steps RPC', async () => {
  const calls = []
  let taskSteps = 10
  const reader = createContextReader({
    discoverServers: async () => [{ pid: 1, token: 'tok', ports: [5000] }],
    requestJson: async ({ rpcPath, body }) => {
      calls.push(rpcPath)
      const parsed = JSON.parse(body || '{}')
      if (rpcPath.endsWith('/GetAllCascadeTrajectories')) {
        return {
          trajectorySummaries: {
            t1: {
              summary: 'Main task',
              stepCount: taskSteps,
              status: 'CASCADE_RUN_STATUS_RUNNING',
              lastModifiedTime: '2026-11-25T03:00:00Z',
            },
            t2: {
              summary: 'Legacy task',
              stepCount: 20,
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: '2026-11-25T02:00:00Z',
            },
            sub1: {
              summary: 'Done child',
              stepCount: 5,
              status: 'CASCADE_RUN_STATUS_IDLE',
              parentCascadeId: 't1',
              lastModifiedTime: '2026-11-25T02:30:00Z',
            },
          },
        }
      }
      if (rpcPath.endsWith('/GetUserStatus')) {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [{ label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' } }],
            },
          },
        }
      }
      if (rpcPath.endsWith('/GetAvailableModels')) return {}
      if (rpcPath.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
        if (parsed.cascadeId === 't1') {
          return {
            generatorMetadata: [
              {
                chatModel: {
                  model: 'MODEL_PLACEHOLDER_M532',
                  usage: { model: 'MODEL_PLACEHOLDER_M532', inputTokens: String(taskSteps * 1000), cacheReadTokens: '40000', outputTokens: '500' },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } },
                },
              },
            ],
          }
        }
        return { generatorMetadata: [] }
      }
      if (rpcPath.endsWith('/GetCascadeTrajectorySteps') && parsed.cascadeId === 't2') {
        return {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              metadata: { modelUsage: { model: 'MODEL_PLACEHOLDER_M35', inputTokens: '80000', outputTokens: '0' } },
            },
          ],
        }
      }
      return null
    },
  })

  const first = await reader.readTasks({ now: 1000 })
  assert.strictEqual(first.ok, true)
  // Idle subagent sub1 is filtered out, leaving t1 and t2.
  assert.deepStrictEqual(
    first.tasks.map(t => t.cascadeId),
    ['t1', 't2'],
  )
  assert.strictEqual(first.tasks[0].contextUsed, 50500)
  assert.strictEqual(first.tasks[1].contextUsed, 80000)
  assert.strictEqual(first.tasks[1].usagePercent, 50)

  const gmCallsAfterFirst = calls.filter(c => c.endsWith('/GetCascadeTrajectoryGeneratorMetadata')).length
  assert.strictEqual(gmCallsAfterFirst, 2)

  // Second poll with identical stepCount+mtime hits cache without calling GM again.
  const second = await reader.readTasks({ now: 2000 })
  assert.strictEqual(second.ok, true)
  const gmCallsAfterSecond = calls.filter(c => c.endsWith('/GetCascadeTrajectoryGeneratorMetadata')).length
  assert.strictEqual(gmCallsAfterSecond, 2)

  // Step count changes for t1 -> only t1 refetches GM.
  taskSteps = 12
  const third = await reader.readTasks({ now: 3000 })
  assert.strictEqual(third.tasks[0].contextUsed, 52500)
  const gmCallsAfterThird = calls.filter(c => c.endsWith('/GetCascadeTrajectoryGeneratorMetadata')).length
  assert.strictEqual(gmCallsAfterThird, 3)
})

test('buildRendererPayload attaches activeTask, pinned state, and honors contextEnabled', () => {
  const usage = normalizeUsage({
    groups: [{ id: 'gemini', limits: [{ kind: 'five_hour', percentUsed: 12 }] }],
  })
  const tasks = [
    { cascadeId: 'a', title: 'Task A', isRunning: true, isSubagent: false, hasContext: true, usagePercent: 34 },
    { cascadeId: 'b', title: 'Task B', isRunning: false, isSubagent: false, hasContext: true, usagePercent: 72 },
  ]
  const payload = buildRendererPayload({
    usage,
    activeModel: 'Gemini 4 Neon (High)',
    tasks,
    pinnedTaskId: 'b',
    contextEnabled: true,
  })
  assert.strictEqual(payload.contextEnabled, true)
  assert.strictEqual(payload.activeTask.cascadeId, 'b')
  assert.strictEqual(payload.activeTask.pinned, true)
  assert.strictEqual(payload.tasks[0].active, false)
  assert.strictEqual(payload.tasks[1].active, true)

  const disabled = buildRendererPayload({ usage, tasks, contextEnabled: false })
  assert.strictEqual(disabled.contextEnabled, false)
  assert.deepStrictEqual(disabled.tasks, [])
  assert.strictEqual(disabled.activeTask, null)
})
