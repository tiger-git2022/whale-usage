import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Shares the account's rate-limit windows with the Claude Whale desktop widget.
// The widget watches this file; every session writes the same account-wide numbers.

type Snapshot = {
  updatedAt: number
  limits: SessionRateLimit[]
  sessionCostUsd?: number
}

async function usagePath($: EngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) return `${configDir}/whale/usage.json`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return `${home}/.claude/whale/usage.json`
}

async function save($: EngineInterface, limits: SessionRateLimit[], sessionCostUsd?: number) {
  if (limits.length === 0) return
  const snapshot: Snapshot = { updatedAt: await $.clock.now(), limits, sessionCostUsd }
  await $.fs.write(await usagePath($), JSON.stringify(snapshot, null, 2))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const usage = await $.session.usage()
    await save($, usage.rateLimits, usage.cost?.usd)
    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await save($, e.rateLimits, e.cost?.usd)
    return next(e)
  })
}
