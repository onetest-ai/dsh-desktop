import { managedBin, managedDir } from './harness-source'
import { envWithLauncherDir } from './server'

/**
 * External effects `runtime-install.ts` needs, injected so tests never touch
 * the network or a real filesystem.
 */
export interface InstallDeps {
  /** Runs a command to completion, capturing output. */
  run(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void },
  ): Promise<{ code: number; stdout: string; stderr: string }>
  /** Whether a path exists on disk. */
  exists(path: string): boolean
  /** Creates a directory, including parents. */
  mkdir(path: string): void
}

/**
 * Run `npm` for a managed install, with `node` reachable on the child's PATH.
 *
 * `npm` is itself a script needing `node` beside it; reuses the same
 * PATH-prepend helper `dshWebCommand` uses for the same reason (see
 * `envWithLauncherDir` in `server.ts`), so the two spawn paths agree on how a
 * resolved `npm` binary's own directory is found.
 * @param deps - injected effects.
 * @param npm - the resolved `npm` binary (absolute path or bare name).
 * @param args - arguments after `npm`.
 * @param options - working directory and per-line output callback.
 * @returns the completed run's exit code and captured output.
 */
function runNpm(
  deps: InstallDeps,
  npm: string,
  args: string[],
  options: { cwd?: string; onLine?: (line: string) => void },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = envWithLauncherDir(npm, process.env)
  return deps.run(npm, args, { cwd: options.cwd, env, onLine: options.onLine })
}

/**
 * Turn a version or dist-tag into the concrete version string `npm view`
 * resolves it to.
 *
 * A dist-tag like `latest` must never be stored in config: a later `npm
 * install` for the same tag re-resolves it at install time and, per the
 * measurements this package is designed around, reinstalls from scratch even
 * when the tag still points at the version already on disk. Resolving once
 * here and persisting the concrete result is what keeps a repeat install a
 * cache hit.
 * @param deps - injected effects.
 * @param npm - the resolved `npm` binary.
 * @param pkg - the package name, e.g. `@deepseek-ai/dsh`.
 * @param spec - a version or dist-tag; an empty string means `latest`.
 * @returns the concrete version string.
 */
export async function resolveVersion(deps: InstallDeps, npm: string, pkg: string, spec: string): Promise<string> {
  const tag = spec === '' ? 'latest' : spec
  const result = await runNpm(deps, npm, ['view', `${pkg}@${tag}`, 'version'], {})
  if (result.code !== 0) {
    throw new Error(`dsh-desktop: npm view ${pkg}@${tag} failed:\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Whether an exact version is already installed.
 *
 * Checked against the binary `spawnFor` will launch, not just the directory
 * existing: a directory can survive a partial or failed `npm install`
 * (dependency resolution written, `node_modules/.bin` not yet linked), and
 * treating that as "installed" would launch a broken binary instead of
 * retrying the install.
 * @param deps - injected effects.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param pkg - the package name.
 * @param version - the exact, already-resolved version.
 * @returns whether the version's binary exists.
 */
export function isInstalled(deps: InstallDeps, dshHome: string, pkg: string, version: string): boolean {
  return deps.exists(managedBin(managedDir(dshHome, pkg, version)))
}

/**
 * Install an exact version if it is not already present.
 *
 * No-ops entirely — `npm` is never invoked — when `isInstalled` already
 * holds: this is the fast path a warm cache and a pinned version make
 * possible, and the entire reason a dist-tag is never installed directly
 * (see `resolveVersion`).
 * @param deps - injected effects.
 * @param npm - the resolved `npm` binary.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param pkg - the package name.
 * @param version - the exact, already-resolved version to install.
 * @param onLine - receives every line of `npm install`'s combined output, for progress logging.
 */
export async function ensureInstalled(
  deps: InstallDeps,
  npm: string,
  dshHome: string,
  pkg: string,
  version: string,
  onLine?: (line: string) => void,
): Promise<void> {
  if (isInstalled(deps, dshHome, pkg, version)) return

  const dir = managedDir(dshHome, pkg, version)
  deps.mkdir(dir)
  const result = await runNpm(
    deps,
    npm,
    ['install', '--prefix', dir, `${pkg}@${version}`, '--no-audit', '--no-fund'],
    { cwd: dshHome, onLine },
  )
  if (result.code !== 0) {
    throw new Error(`dsh-desktop: npm install ${pkg}@${version} failed:\n${result.stderr}`)
  }
}

/**
 * The registry's current `latest` version, for offering an update.
 * @param deps - injected effects.
 * @param npm - the resolved `npm` binary.
 * @param pkg - the package name.
 * @returns the concrete version `latest` currently resolves to.
 */
export function latestVersion(deps: InstallDeps, npm: string, pkg: string): Promise<string> {
  return resolveVersion(deps, npm, pkg, 'latest')
}

/**
 * Whether the registry's `latest` differs from the pinned, installed
 * version.
 *
 * Deliberately not a semver comparison: the harness has no policy yet for
 * "installed is newer than latest" or prerelease ordering, and a version or
 * dist-tag is opaque past what `npm view` already resolved for us. Equality
 * with the currently installed string is the only signal this needs.
 * @param installed - the version currently installed, as stored in config.
 * @param latest - the registry's current `latest`, from `latestVersion`.
 * @returns whether they differ.
 */
export function updateAvailable(installed: string, latest: string): boolean {
  return installed !== latest
}
