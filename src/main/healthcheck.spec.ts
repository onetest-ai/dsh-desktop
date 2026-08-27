import { describe, expect, it } from 'vitest'
import type { DesktopConfig } from './config'
import { repairablePlugins, runHealthcheck, type Finding, type HealthcheckDeps } from './healthcheck'

/** Deps where everything is healthy, overridable per test. */
function deps(overrides: Partial<HealthcheckDeps> = {}): HealthcheckDeps {
  return {
    preflight: () => ({ ok: true }),
    statusFor: () => ({ kind: 'ready', package: 'p', entryPath: '/p/index.js', probeDirectory: '/p', packageDir: '/p' }),
    binaryResolves: () => true,
    shellPathCached: () => true,
    ...overrides,
  }
}

/** A config with the given plugins, otherwise valid. */
function config(plugins: { spec: string; version?: string }[] = []): DesktopConfig {
  return { harness: { kind: 'local', repo: '/tmp/h' }, notifyPort: 1, hotkey: 'X', plugins }
}

/** The finding with the given id, if present. */
function find(findings: Finding[], id: string): Finding | undefined {
  return findings.find((finding) => finding.id === id)
}

describe('runHealthcheck', () => {
  it('reports everything ok on a healthy install', () => {
    expect(runHealthcheck(config(), deps()).every((finding) => finding.severity === 'ok')).toBe(true)
  })

  it('blocks on a harness source that is not usable, since nothing else can run', () => {
    const findings = runHealthcheck(config(), deps({ preflight: () => ({ ok: false, message: 'no dist' }) }))
    expect(find(findings, 'harness')?.severity).toBe('blocked')
    expect(find(findings, 'harness')?.detail).toContain('no dist')
  })

  it('marks a declared but uninstalled plugin repairable, not failed', () => {
    const findings = runHealthcheck(
      config([{ spec: 'dsh-project-mcp-bridge@0.2.1' }]),
      deps({ statusFor: () => ({ kind: 'unavailable', package: 'dsh-project-mcp-bridge', reason: 'not installed yet' }) }),
    )
    expect(find(findings, 'plugin:dsh-project-mcp-bridge')?.severity).toBe('repairable')
  })

  it('carries the spec to install, so repair needs no second lookup', () => {
    const findings = runHealthcheck(
      config([{ spec: 'dsh-project-mcp-bridge@0.2.1' }]),
      deps({ statusFor: () => ({ kind: 'unavailable', package: 'dsh-project-mcp-bridge', reason: 'not installed yet' }) }),
    )
    expect(find(findings, 'plugin:dsh-project-mcp-bridge')?.repair).toEqual({
      kind: 'install-plugin',
      spec: 'dsh-project-mcp-bridge@0.2.1',
    })
  })

  it('reports an installed plugin as ok', () => {
    expect(find(runHealthcheck(config([{ spec: 'p', version: '1.0.0' }]), deps()), 'plugin:p')?.severity).toBe('ok')
  })

  it('reports a missing binary as blocked, since installing needs it', () => {
    const findings = runHealthcheck(config(), deps({ binaryResolves: (_c, name) => name !== 'npm' }))
    expect(find(findings, 'binary:npm')?.severity).toBe('blocked')
  })

  it('reports an absent shell-PATH cache as ok, because it is an optimisation', () => {
    // A first launch has none, and the app works without it — flagging it
    // would turn a normal first run into a scary screen.
    expect(find(runHealthcheck(config(), deps({ shellPathCached: () => false })), 'shell-path')?.severity).toBe('ok')
  })

  it('keeps findings in a stable order, so the screen does not reshuffle between runs', () => {
    const ids = runHealthcheck(config([{ spec: 'b' }, { spec: 'a' }]), deps()).map((finding) => finding.id)
    expect(ids.slice(0, 2)).toEqual(['harness', 'binary:pnpm'])
    expect(ids.slice(-2)).toEqual(['plugin:b', 'plugin:a'])
  })
})

describe('repairablePlugins', () => {
  it('lists the specs to install, in finding order', () => {
    const findings = runHealthcheck(
      config([{ spec: 'a@1.0.0' }, { spec: 'b@2.0.0' }]),
      deps({ statusFor: () => ({ kind: 'unavailable', package: 'x', reason: 'not installed yet' }) }),
    )
    expect(repairablePlugins(findings)).toEqual(['a@1.0.0', 'b@2.0.0'])
  })

  it('lists nothing when everything is installed', () => {
    expect(repairablePlugins(runHealthcheck(config([{ spec: 'a', version: '1' }]), deps()))).toEqual([])
  })
})
