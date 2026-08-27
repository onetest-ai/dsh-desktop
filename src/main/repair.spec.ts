import { describe, expect, it, vi } from 'vitest'
import { repairPlugins, type RepairDeps } from './repair'

/** Deps whose installs succeed, overridable per test. */
function deps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return { installPlugin: vi.fn(async () => '1.0.0'), isQuitting: () => false, ...overrides }
}

describe('repairPlugins', () => {
  it('installs every missing plugin', async () => {
    const d = deps()
    const outcome = await repairPlugins(['a@1.0.0', 'b@2.0.0'], undefined, d, () => {})
    expect(outcome.installed).toEqual([
      { spec: 'a@1.0.0', version: '1.0.0' },
      { spec: 'b@2.0.0', version: '1.0.0' },
    ])
    expect(vi.mocked(d.installPlugin)).toHaveBeenCalledTimes(2)
  })

  it('installs the pinned version a spec names, rather than latest', async () => {
    const d = deps()
    await repairPlugins(['a@1.2.3'], undefined, d, () => {})
    expect(vi.mocked(d.installPlugin).mock.calls[0].slice(0, 2)).toEqual(['a', '1.2.3'])
  })

  it('installs latest for an unpinned spec', async () => {
    const d = deps()
    await repairPlugins(['a'], undefined, d, () => {})
    expect(vi.mocked(d.installPlugin).mock.calls[0].slice(0, 2)).toEqual(['a', 'latest'])
  })

  it('streams install output, which is the whole point of showing a screen', async () => {
    const lines: string[] = []
    const d = deps({
      installPlugin: vi.fn(async (_p, _v, _n, onLine) => {
        onLine('added 101 packages')
        return '1.0.0'
      }),
    })
    await repairPlugins(['a'], undefined, d, (line) => lines.push(line))
    expect(lines).toContain('added 101 packages')
  })

  it('reports a failure without abandoning the rest', async () => {
    const d = deps({
      installPlugin: vi.fn(async (pkg) => {
        if (pkg === 'a') throw new Error('registry unreachable')
        return '1.0.0'
      }),
    })
    const outcome = await repairPlugins(['a', 'b'], undefined, d, () => {})
    expect(outcome.failed).toEqual([{ spec: 'a', reason: 'registry unreachable' }])
    expect(outcome.installed).toEqual([{ spec: 'b', version: '1.0.0' }])
  })

  it('stops spawning installs once quitting lands, rather than working behind the quit', async () => {
    let quitting = false
    const d = deps({
      isQuitting: () => quitting,
      installPlugin: vi.fn(async () => {
        quitting = true
        return '1.0.0'
      }),
    })
    const outcome = await repairPlugins(['a', 'b', 'c'], undefined, d, () => {})
    expect(vi.mocked(d.installPlugin)).toHaveBeenCalledTimes(1)
    expect(outcome.installed).toEqual([{ spec: 'a', version: '1.0.0' }])
  })

  // reason: an entry with no recorded version reads as uninstalled, so a
  // repair that discards what npm resolved makes the next launch install the
  // same plugin again — which is exactly what an unpinned spec did.
  it('carries out the version npm resolved, not the one the spec asked for', async () => {
    const d = deps({ installPlugin: vi.fn(async () => '3.4.5') })
    const outcome = await repairPlugins(['a'], undefined, d, () => {})
    expect(outcome.installed).toEqual([{ spec: 'a', version: '3.4.5' }])
  })

  it('does nothing at all when there is nothing to repair', async () => {
    const d = deps()
    expect(await repairPlugins([], undefined, d, () => {})).toEqual({ installed: [], failed: [] })
    expect(vi.mocked(d.installPlugin)).not.toHaveBeenCalled()
  })
})
