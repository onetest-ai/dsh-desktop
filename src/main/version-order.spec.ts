import { describe, expect, it } from 'vitest'
import { isOlder } from './version-order'

describe('isOlder', () => {
  it.each([
    ['0.1.0', '0.1.2'],
    ['0.1.9', '0.2.0'],
    ['0.9.9', '1.0.0'],
    ['1.2.3', '1.2.4'],
  ])('puts %s before %s', (version, than) => {
    expect(isOlder(version, than)).toBe(true)
    expect(isOlder(than, version)).toBe(false)
  })

  it('reports equal versions as not older, in both directions', () => {
    expect(isOlder('0.1.2', '0.1.2')).toBe(false)
  })

  // reason: this is what `0.1.1-rc.1 < 0.1.1-rc.2 < 0.1.1` needs.
  it('puts a prerelease before the release it leads to', () => {
    expect(isOlder('0.1.1-rc.2', '0.1.1')).toBe(true)
    expect(isOlder('0.1.1', '0.1.1-rc.2')).toBe(false)
  })

  it('orders two prereleases by their own parts', () => {
    expect(isOlder('0.1.1-rc.1', '0.1.1-rc.2')).toBe(true)
    expect(isOlder('0.1.1-rc.10', '0.1.1-rc.9')).toBe(false)
    expect(isOlder('0.1.1-alpha', '0.1.1-beta')).toBe(true)
  })

  it('treats a shorter prerelease as earlier when the parts match', () => {
    expect(isOlder('0.1.1-rc', '0.1.1-rc.1')).toBe(true)
  })

  // reason: an unparseable version treated as behind would be quietly
  // replaced, which is the one outcome worth avoiding here.
  it.each([
    ['latest', '0.1.2'],
    ['0.1.2', 'latest'],
    ['', '0.1.2'],
    ['0.1', '0.1.2'],
    ['v0.1.2', '0.1.3'],
  ])('reports %s against %s as not older', (version, than) => {
    expect(isOlder(version, than)).toBe(false)
  })
})
