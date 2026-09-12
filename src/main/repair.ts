import type { InstalledPlugin } from './plugin-entries'

/** The effects repair needs, injected so tests spawn no `npm`. */
export interface RepairDeps {
  /**
   * Resolve and install one plugin, streaming `npm` output.
   *
   * The same call a Settings save makes: an entry repaired at startup must be
   * indistinguishable from one installed by a save, so there is exactly one
   * install path to reason about. A repaired entry has never installed here, so
   * it carries no prior version or discovered package name.
   * @param spec - the entry's spec, as stored.
   * @param priorVersion - the version last installed, if any (none, at repair).
   * @param priorPackage - the github name last discovered, if any (none, at repair).
   * @param npmPath - the configured `npm` override.
   * @param onLine - receives install output as it arrives.
   * @returns the concrete version (or SHA) and, for github, the discovered name.
   */
  installPlugin(
    spec: string,
    priorVersion: string | undefined,
    priorPackage: string | undefined,
    npmPath: string | undefined,
    onLine: (line: string) => void,
  ): Promise<InstalledPlugin>
  isQuitting(): boolean
}

/** What a repair pass managed and what it could not. */
export interface RepairOutcome {
  /**
   * Each repaired spec with the version `npm` actually resolved, and — for a
   * github entry — the npm package name discovered from the installed tree.
   *
   * The version is carried out rather than discarded because an entry with no
   * recorded version reads as uninstalled: without writing it back, every
   * launch would find the same plugin missing and install it again. The
   * discovered name is carried out for the same reason: a github entry with no
   * recorded name cannot be resolved to its `node_modules` directory at boot.
   */
  installed: { spec: string; version: string; package?: string }[]
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
  const installed: { spec: string; version: string; package?: string }[] = []
  const failed: { spec: string; reason: string }[] = []
  for (const spec of specs) {
    if (deps.isQuitting()) break
    try {
      // A repaired entry has never installed here: no prior version or name.
      const result = await deps.installPlugin(spec, undefined, undefined, npmPath, onLine)
      installed.push({ spec, version: result.version, ...(result.package === undefined ? {} : { package: result.package }) })
    } catch (error) {
      failed.push({ spec, reason: (error as Error).message })
    }
  }
  return { installed, failed }
}
