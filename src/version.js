// Release versions are plain "X.Y.Z" (tag "v0.8.0"); older releases were "<base version>-t<N>" (tag
// "v0.1.0-t015", older ones "v0.1.0-t12"), see .github/workflows/build.yml.
// The numbers compare first, then N (0 without "-t"), so every plain release is newer than the old
// numbered ones (0.8.0 > 0.1.0-t015). Same rules as the EhViewer fork's ForkVersion.

const PATTERN = /^v?(\d+(?:\.\d+)*)(?:-t(\d+))?$/

function parse(version) {
  const match = PATTERN.exec(String(version).trim())
  if (!match) return null
  return { base: match[1].split('.').map(Number), build: Number(match[2] ?? 0) }
}

/**
 * Whether release `latest` is newer than the running `current` version. A version this can't read
 * (a local build with some other suffix) is older than any release.
 */
function isNewer(latest, current) {
  const next = parse(latest)
  if (!next) return false
  const now = parse(current)
  if (!now) return true
  const length = Math.max(next.base.length, now.base.length)
  for (let i = 0; i < length; i++) {
    const a = next.base[i] ?? 0
    const b = now.base[i] ?? 0
    if (a !== b) return a > b
  }
  return next.build > now.build
}

module.exports = { isNewer }
