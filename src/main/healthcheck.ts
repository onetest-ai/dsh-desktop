import type { DesktopConfig } from './config'
import type { HarnessSource } from './harness-source'
import { parseSpec, type PluginEntry, type PluginStatus } from './plugin-entries'

/**
 * How much a finding matters.
 *
 * `repairable` is the reason this exists: a declared plugin that is not
 * installed is a setup step the app can complete itself, and reporting it as
 * a failure — which the Plugins tab did — blames the user for a state they
 * did not create.
 */
export type FindingSeverity = 'ok' | 'repairable' | 'blocked'

/** One checked thing, and what can be done about it. */
export interface Finding {
  /** Stable identity for the renderer and for tests; never a display string. */
  id: string
  title: string
  detail?: string
  severity: FindingSeverity
  /**
   * How to fix it, when the app can. Carried on the finding so repair needs
   * no second lookup and cannot disagree with what was reported.
   */
  repair?: { kind: 'install-plugin'; spec: string }
}

/** Everything the check reads, injected so tests touch no filesystem. */
export interface HealthcheckDeps {
  /**
   * Whether the harness source is usable.
   * @param source - the configured source.
   * @returns ok, or the reason it cannot be used.
   */
  preflight(source: HarnessSource): { ok: boolean; message?: string }
  /**
   * Where one plugin entry stands.
   * @param entry - the configured entry.
   * @returns ready with its resolved paths, or unavailable with why.
   */
  statusFor(entry: PluginEntry): PluginStatus
  /**
   * Whether a launcher binary can be resolved.
   * @param configured - the configured absolute path, when set.
   * @param name - the binary name.
   * @returns whether it resolves.
   */
  binaryResolves(configured: string | undefined, name: string): boolean
  /**
   * Whether a resolved login-shell PATH is cached.
   * @returns whether the cache is present.
   */
  shellPathCached(): boolean
}

/**
 * Check the install, without changing anything.
 *
 * Order is fixed rather than derived, so the screen does not reshuffle
 * between runs: harness, binaries, shell PATH, then plugins in configured
 * order.
 * @param config - the stored settings.
 * @param deps - the injected reads.
 * @returns every finding, in that fixed order.
 */
export function runHealthcheck(config: DesktopConfig, deps: HealthcheckDeps): Finding[] {
  const findings: Finding[] = []

  const source = deps.preflight(config.harness)
  findings.push({
    id: 'harness',
    title: 'Harness',
    severity: source.ok ? 'ok' : 'blocked',
    ...(source.message === undefined ? {} : { detail: source.message }),
  })

  for (const [name, configured] of [
    ['pnpm', config.pnpmPath],
    ['npm', config.npmPath],
  ] as const) {
    const resolves = deps.binaryResolves(configured, name)
    findings.push({
      id: `binary:${name}`,
      title: name,
      severity: resolves ? 'ok' : 'blocked',
      ...(resolves ? {} : { detail: `${name} could not be found. Set its path on the Advanced tab.` }),
    })
  }

  // Always ok: the cache is an optimisation, absent on every first launch,
  // and the app works without it. Reporting it would make a normal first run
  // look broken.
  findings.push({
    id: 'shell-path',
    title: 'Shell PATH',
    severity: 'ok',
    ...(deps.shellPathCached() ? {} : { detail: 'Not resolved yet; it is read in the background.' }),
  })

  for (const entry of config.plugins ?? []) {
    const status = deps.statusFor(entry)
    const { package: pkg } = parseSpec(entry.spec)
    findings.push({
      id: `plugin:${pkg}`,
      title: pkg,
      severity: status.kind === 'ready' ? 'ok' : 'repairable',
      ...(status.kind === 'ready'
        ? {}
        : { detail: status.reason, repair: { kind: 'install-plugin' as const, spec: entry.spec } }),
    })
  }

  return findings
}

/**
 * The plugin specs a repair pass should install.
 * @param findings - what the check produced.
 * @returns the specs, in finding order.
 */
export function repairablePlugins(findings: Finding[]): string[] {
  const specs: string[] = []
  for (const finding of findings) {
    if (finding.severity === 'repairable' && finding.repair?.kind === 'install-plugin') specs.push(finding.repair.spec)
  }
  return specs
}
