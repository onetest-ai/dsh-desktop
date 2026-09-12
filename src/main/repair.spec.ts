import { describe, expect, it, vi } from 'vitest'
import { repairPlugins, type RepairDeps } from './repair'

/** Deps whose installs succeed, overridable per test. */
function deps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return { installPlugin: vi.fn(async () => ({ version: '1.0.0' })), isQuitting: () => false, ...overrides }
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

  // reason: version resolution (pinned vs latest) is the installer's job now,
  // shared with a Settings save; repair only passes each spec through, with no
  // prior version or discovered name because a repaired entry never installed here.
  it('passes each spec to the installer with no prior version or package', async () => {
    const d = deps()
    await repairPlugins(['a@1.2.3'], '/usr/bin/npm', d, () => {})
    expect(vi.mocked(d.installPlugin).mock.calls[0].slice(0, 4)).toEqual(['a@1.2.3', undefined, undefined, '/usr/bin/npm'])
  })

  it('streams install output, which is the whole point of showing a screen', async () => {
    const lines: string[] = []
    const d = deps({
      installPlugin: vi.fn(async (_spec, _pv, _pp, _npm, onLine) => {
        onLine('added 101 packages')
        return { version: '1.0.0' }
      }),
    })
    await repairPlugins(['a'], undefined, d, (line) => lines.push(line))
    expect(lines).toContain('added 101 packages')
  })

  it('reports a failure without abandoning the rest', async () => {
    const d = deps({
      installPlugin: vi.fn(async (spec) => {
        if (spec === 'a') throw new Error('registry unreachable')
        return { version: '1.0.0' }
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
        return { version: '1.0.0' }
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
    const d = deps({ installPlugin: vi.fn(async () => ({ version: '3.4.5' })) })
    const outcome = await repairPlugins(['a'], undefined, d, () => {})
    expect(outcome.installed).toEqual([{ spec: 'a', version: '3.4.5' }])
  })

  // reason: a github entry cannot be resolved to its node_modules directory at
  // boot without the npm name discovered at install, so repair must carry it out.
  it('carries out the discovered package name for a github entry', async () => {
    const d = deps({ installPlugin: vi.fn(async () => ({ version: 'abc123', package: 'dsh-task-models' })) })
    const outcome = await repairPlugins(['github:TTTPOB/dsh-task-models'], undefined, d, () => {})
    expect(outcome.installed).toEqual([{ spec: 'github:TTTPOB/dsh-task-models', version: 'abc123', package: 'dsh-task-models' }])
  })

  it('does nothing at all when there is nothing to repair', async () => {
    const d = deps()
    expect(await repairPlugins([], undefined, d, () => {})).toEqual({ installed: [], failed: [] })
    expect(vi.mocked(d.installPlugin)).not.toHaveBeenCalled()
  })
})
