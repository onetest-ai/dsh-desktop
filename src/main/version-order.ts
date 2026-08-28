/**
 * Whether one version is older than another.
 *
 * Enough semver for the versions this app pins: dotted numbers with an
 * optional prerelease tail (`0.1.1-rc.2`). A prerelease sorts before the
 * release it leads to, and two prereleases sort by their own parts —
 * which is the whole of what `0.1.1-rc.1 < 0.1.1-rc.2 < 0.1.1` needs.
 *
 * Anything it cannot read sorts as not-older, so an unparseable version is
 * never treated as behind and quietly replaced.
 * @param version - the version to test.
 * @param than - the version to compare against.
 * @returns whether `version` precedes `than`.
 */
export function isOlder(version: string, than: string): boolean {
  const left = parse(version)
  const right = parse(than)
  if (left === undefined || right === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    if (left.release[index] !== right.release[index]) return left.release[index] < right.release[index]
  }
  // Same release: a prerelease precedes the release itself.
  if (left.pre.length === 0 || right.pre.length === 0) return left.pre.length > right.pre.length
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const one = left.pre[index]
    const other = right.pre[index]
    if (one === undefined) return true
    if (other === undefined) return false
    if (one !== other) return typeof one === 'number' && typeof other === 'number' ? one < other : String(one) < String(other)
  }
  return false
}

/**
 * Split a version into its release numbers and prerelease parts.
 * @param version - the version to read.
 * @returns its parts, or undefined when it is not a version this can order.
 */
function parse(version: string): { release: number[]; pre: (string | number)[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim())
  if (match === null) return undefined
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: (match[4] ?? '').split('.').filter((part) => part !== '').map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  }
}
