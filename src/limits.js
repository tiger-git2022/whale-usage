// Turns claude.ai's usage answer into the plugin's shape, and merges the two sources.
// Both describe the same account-wide windows: { kind, percentUsed, resetsAt }.

// The windows claude.ai reports that the widget shows, by the plugin's names
const WEB_KINDS = ['five_hour', 'seven_day']

// claude.ai answers GET /api/organizations/<id>/usage with
// { five_hour: { utilization, resets_at }, seven_day: { ... }, ... }; a window not in use may be null.
function fromWeb(body) {
  const limits = []
  for (const kind of WEB_KINDS) {
    const w = body?.[kind]
    if (!w || typeof w.utilization !== 'number') continue
    const resetsAt = w.resets_at && !Number.isNaN(Date.parse(w.resets_at)) ? new Date(w.resets_at).toISOString() : undefined
    limits.push({ kind, percentUsed: w.utilization, resetsAt })
  }
  return limits
}

const sameWindow = (a, b) =>
  a.resetsAt !== undefined && b.resetsAt !== undefined && Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) < 60 * 1000

// The plugin's file and claude.ai's answer, as one usage for the widget. For each window: within the
// same window use only grows, so the higher reading wins; otherwise the newer source wins (a window
// that reset). Windows only one source knows are kept.
function merge(file, web) {
  if (!web || web.limits.length === 0) return file
  if (!file || !Array.isArray(file.limits) || file.limits.length === 0) return { updatedAt: web.at, limits: web.limits }
  const webNewer = web.at >= (file.updatedAt ?? 0)
  const limits = file.limits.map(old => {
    const fresh = web.limits.find(l => l.kind === old.kind)
    if (!fresh) return old
    if (sameWindow(old, fresh)) return fresh.percentUsed >= old.percentUsed ? fresh : old
    return webNewer ? fresh : old
  })
  for (const fresh of web.limits) if (!limits.some(l => l.kind === fresh.kind)) limits.push(fresh)
  return { ...file, updatedAt: Math.max(file.updatedAt ?? 0, web.at), limits }
}

module.exports = { fromWeb, merge }
