import { parseSpec } from './plugin-entries'

/** The effects repair needs, injected so tests spawn no `npm`. */
export interface RepairDeps {
  /**
   * Resolve and install one plugin, streaming `npm` output.
   *
   * The same call a Settings save makes: an entry repaired at startup must be
   * indistinguishable from one installed by a save, so there is exactly one
   * install path to reason about.
   * @param pkg - the package name.
   * @param version - the concrete version or dist-tag to install.
   * @param npmPath - the configured `npm` override.
   * @param onLine - receives install output as it arrives.
   * @returns the concrete installed version.
   */
  installPlugin(pkg: string, version: string, npmPath: string | undefined, onLine: (line: string) => void): Promise<string>
  isQuitting(): boolean
}

/** What a repair pass managed and what it could not. */
export interface RepairOutcome {
  installed: string[]
  failed: { spec: string; reason: string }[]
}

/**
 * Install the plugins the healthcheck found missing.
 *
 * A single failure never abandons the rest: plugins are independent, and one
 * unreachable package must not cost the user the others. `isQuitting` is
 * checked before every install rather than once, because each call spawns a
 * detached `npm` that only the quit path's own reap would ever collect — and
 * that reap runs once, before this loop could still be running.
 * @param specs - the specs to install, as `repairablePlugins` returned them.
 * @param npmPath - the configured `npm` override.
 * @param deps - injected effects.
 * @param onLine - receives install output as it arrives.
 * @returns what was installed and what failed.
 */
export async function repairPlugins(
  specs: string[],
  npmPath: string | undefined,
  deps: RepairDeps,
  onLine: (line: string) => void,
): Promise<RepairOutcome> {
  const installed: string[] = []
  const failed: { spec: string; reason: string }[] = []
  for (const spec of specs) {
    if (deps.isQuitting()) break
    const { package: pkg, pinnedVersion } = parseSpec(spec)
    try {
      await deps.installPlugin(pkg, pinnedVersion ?? 'latest', npmPath, onLine)
      installed.push(spec)
    } catch (error) {
      failed.push({ spec, reason: (error as Error).message })
    }
  }
  return { installed, failed }
}
