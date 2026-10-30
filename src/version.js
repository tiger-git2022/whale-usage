// Release versions are "<base version>-t<N>" (tag "v0.1.0-t003", older ones "v0.1.0-t12"), see
// .github/workflows/build.yml.
// A higher base version is newer, then a higher N. Same rules as the EhViewer fork's ForkVersion.

const PATTERN = /^v?(\d+(?:\.\d+)*)-t(\d+)$/

function parse(version) {
  const match = PATTERN.exec(String(version).trim())
  if (!match) return null
  return { base: match[1].split('.').map(Number), build: Number(match[2]) }
}

/**
 * Whether release `latest` is newer than the running `current` version. A build without a release
 * number (a local build) is older than any release; a release without one is never offered.
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
