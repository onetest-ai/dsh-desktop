import { managedBin, managedDir, managedStagingDir } from './harness-source'
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
    options: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>
  /** Whether a path exists on disk. */
  exists(path: string): boolean
  /** Creates a directory, including parents. */
  mkdir(path: string): void
  /** Removes a directory and its contents; succeeds when it is already absent. */
  rm(path: string): void
  /** Moves a directory to a new path on the same filesystem. */
  rename(from: string, to: string): void
}

/**
 * Upper bound on a `npm view` metadata lookup.
 *
 * The lookup is one registry request for one field, and it runs on the path
 * that opens Settings and the path that saves it. A registry that has accepted
 * the connection and then stalled would otherwise leave Save disabled with no
 * way out, so the bound is set well above any healthy response time but far
 * below the install's.
 */
const VIEW_TIMEOUT_MS = 60_000

/**
 * Upper bound on one `npm install` of a managed runtime.
 *
 * A measured cold install of this package's dependency tree — 62 direct
 * workspace dependencies whose transitive tree builds node-pty, sharp, and
 * koffi — takes about 375 seconds; a warm one is skipped entirely by
 * `isInstalled`. Fifteen minutes is roughly 2.4x the measured cold figure,
 * which leaves room for a slow network or a slower machine while still
 * bounding a hung install rather than letting it disable Save forever.
 */
const INSTALL_TIMEOUT_MS = 900_000

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
  options: { cwd?: string; onLine?: (line: string) => void; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = envWithLauncherDir(npm, process.env)
  return deps.run(npm, args, { cwd: options.cwd, env, onLine: options.onLine, timeoutMs: options.timeoutMs })
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
  const result = await runNpm(deps, npm, ['view', `${pkg}@${tag}`, 'version'], { timeoutMs: VIEW_TIMEOUT_MS })
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
 * retrying the install. The directory itself only ever appears complete —
 * `ensureInstalled` installs into a staging sibling and renames — so the two
 * checks agree rather than one covering for the other.
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
 *
 * The install runs in a staging directory and is renamed into place only on
 * success, so a run killed by quit or cut short by `INSTALL_TIMEOUT_MS` can
 * never leave something a later `isInstalled` accepts (see
 * `managedStagingDir`). Whatever occupied the target directory is removed just
 * before the rename, so a retry always converges rather than failing forever
 * on residue.
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

  const staging = managedStagingDir(dshHome, pkg, version)
  // Residue from an install that was killed or timed out on an earlier
  // attempt; npm would otherwise install on top of a partial tree.
  deps.rm(staging)
  deps.mkdir(staging)

  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await runNpm(
      deps,
      npm,
      ['install', '--prefix', staging, `${pkg}@${version}`, '--no-audit', '--no-fund'],
      { cwd: dshHome, onLine, timeoutMs: INSTALL_TIMEOUT_MS },
    )
  } catch (error) {
    deps.rm(staging)
    throw error
  }
  if (result.code !== 0) {
    deps.rm(staging)
    throw new Error(`dsh-desktop: npm install ${pkg}@${version} failed:\n${result.stderr}`)
  }

  const dir = managedDir(dshHome, pkg, version)
  // A non-empty directory can sit here with no linked binary — an install
  // killed before staging existed, or a package that links no `dsh` bin — and
  // `isInstalled` correctly reports it as absent. Renaming onto a non-empty
  // target fails with ENOTEMPTY, so without this every retry would fail
  // identically and the install could never be repaired from inside the app.
  //
  // Removed only here, after the staging install has already succeeded: the
  // replacement is on disk, so this cannot delete a working install and then
  // fail to produce one. The path is derived for this exact package and
  // version, never a parent of it.
  deps.rm(dir)
  deps.rename(staging, dir)
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
