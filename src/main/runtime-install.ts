import { join } from 'node:path'
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
  /** Reads a file as UTF-8 text; throws when it is absent or unreadable. */
  readText(path: string): string
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
 * A package with no `bin` entry (the hook bridge, unlike the core `dsh`
 * package) links nothing at `managedBin` to check, so the completion marker
 * is injectable: it defaults to `managedBin` for a package launched
 * directly, and a caller installing a library-only package passes its own
 * marker instead — e.g. the installed package's own `package.json`.
 * @param deps - injected effects.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param pkg - the package name.
 * @param version - the exact, already-resolved version.
 * @param marker - resolves the install directory to the path whose existence means the install is complete.
 * @returns whether the version's completion marker exists.
 */
export function isInstalled(
  deps: InstallDeps,
  dshHome: string,
  pkg: string,
  version: string,
  marker: (dir: string) => string = managedBin,
): boolean {
  return deps.exists(marker(managedDir(dshHome, pkg, version)))
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
 * @param marker - forwarded to `isInstalled`; see there for why a library-only package needs one.
 */
export async function ensureInstalled(
  deps: InstallDeps,
  npm: string,
  dshHome: string,
  pkg: string,
  version: string,
  onLine?: (line: string) => void,
  marker: (dir: string) => string = managedBin,
): Promise<void> {
  if (isInstalled(deps, dshHome, pkg, version, marker)) return

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

/**
 * Upper bound on one `git ls-remote` lookup — one network round trip to
 * resolve a ref to a commit, on the same Save path `resolveVersion` runs on.
 */
const LS_REMOTE_TIMEOUT_MS = 60_000

/** The HTTPS clone URL for a public GitHub repository. */
function githubHttpsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`
}

/**
 * Resolve a GitHub repo's ref to the exact commit it points at.
 *
 * A ref (a branch or tag) is mutable, so it is resolved to an immutable commit
 * SHA here and only that SHA is ever installed or stored — the git equivalent
 * of {@link resolveVersion} turning a dist-tag into a concrete version, which
 * is what keeps a repeat install a cache hit. `git ls-remote` reads the remote
 * without cloning and needs no credentials for a public repo.
 * @param deps - injected effects.
 * @param git - the resolved `git` binary.
 * @param owner - the repo owner.
 * @param repo - the repo name.
 * @param ref - the branch, tag, or SHA to resolve; the default branch when omitted.
 * @returns the 40-character commit SHA.
 */
export async function resolveGitRef(
  deps: InstallDeps,
  git: string,
  owner: string,
  repo: string,
  ref?: string,
): Promise<string> {
  const url = githubHttpsUrl(owner, repo)
  const args = ref === undefined ? ['ls-remote', url, 'HEAD'] : ['ls-remote', url, ref]
  const result = await deps.run(git, args, { timeoutMs: LS_REMOTE_TIMEOUT_MS })
  if (result.code !== 0) {
    throw new Error(`dsh-desktop: git ls-remote ${url} ${ref ?? 'HEAD'} failed:\n${result.stderr}`)
  }
  // `<sha>\t<ref>` lines, one per matching ref. A branch/tag/HEAD matches one;
  // the first field of the first line is the commit.
  const sha = result.stdout.split('\n')[0]?.split('\t')[0]?.trim()
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    // A ref that matches nothing produces empty output with a zero exit; a SHA
    // passed as the ref is not resolvable by ls-remote and lands here too.
    if (ref !== undefined && /^[0-9a-f]{7,40}$/i.test(ref)) return ref.toLowerCase()
    throw new Error(`dsh-desktop: git ls-remote ${url} found no ref "${ref ?? 'HEAD'}"`)
  }
  return sha
}

/**
 * The npm package name a `github:` install actually landed, read from the tree
 * npm wrote into the staging prefix.
 *
 * `npm install --prefix <dir> github:owner/repo#sha` writes a generated
 * `<dir>/package.json` whose single `dependencies` key is the installed
 * package's own name — verified live against `lincong1987/dsh-model-switch`,
 * whose repo name and package name differ. That key is the authoritative name
 * (the repo name is not it), and every downstream path — the profile link, the
 * overlay row, the package directory — needs it.
 * @param deps - injected effects.
 * @param installDir - the `--prefix` directory the install wrote into.
 * @returns the discovered package name.
 * @throws when the generated manifest names no single dependency.
 */
export function discoverInstalledPackage(deps: InstallDeps, installDir: string): string {
  const manifest = JSON.parse(deps.readText(join(installDir, 'package.json'))) as { dependencies?: Record<string, unknown> }
  const names = Object.keys(manifest.dependencies ?? {})
  if (names.length !== 1) {
    throw new Error(`dsh-desktop: the git install wrote ${names.length} top-level dependencies, expected exactly one`)
  }
  return names[0]
}

/**
 * Fail loudly when a freshly installed package ships no usable entry point.
 *
 * A GitHub repo that neither commits its build output nor declares a working
 * `prepare` script installs "successfully" and then fails to load as a plugin
 * — a silent broken state. This turns that into a clear install error naming
 * the cause. The manifest is read inline (not through `plugin-entries.ts`) to
 * keep this module free of a runtime import cycle.
 * @param deps - injected effects.
 * @param installDir - the `--prefix` directory the install wrote into.
 * @param pkg - the discovered package name.
 * @throws when the entry file, or a declared bundle patch, is absent.
 */
function assertPluginBuilt(deps: InstallDeps, installDir: string, pkg: string): void {
  const packageDir = join(installDir, 'node_modules', ...pkg.split('/'))
  const manifest = JSON.parse(deps.readText(join(packageDir, 'package.json'))) as {
    main?: string
    exports?: unknown
    dsh?: { bundle?: { patch?: string } }
  }
  const exportsDot = typeof manifest.exports === 'string'
    ? manifest.exports
    : (() => {
        const dot = (manifest.exports as Record<string, unknown> | null | undefined)?.['.']
        if (typeof dot === 'string') return dot
        if (dot !== null && typeof dot === 'object') {
          const c = dot as Record<string, unknown>
          const value = c.default ?? c.import ?? c.require ?? c.node
          return typeof value === 'string' ? value : undefined
        }
        return undefined
      })()
  const entry = exportsDot ?? manifest.main
  if (entry === undefined) {
    throw new Error(`${pkg} declares no "main" or exports["."]: the repository ships no built entry point`)
  }
  if (!deps.exists(join(packageDir, entry))) {
    throw new Error(`${pkg}'s entry "${entry}" is missing: the repository must commit its build output or declare a working "prepare" script`)
  }
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string' && !deps.exists(join(packageDir, patch))) {
    throw new Error(`${pkg}'s declared bundle patch "${patch}" is missing from the installed package`)
  }
}

/** A resolved git install: the immutable commit it pinned, and the package it landed. */
export interface GitInstallResult {
  /** The 40-character commit SHA, stored where a version goes. */
  version: string
  /** The discovered npm package name, stored on the entry. */
  package: string
}

/**
 * Resolve, install, and verify a `github:` plugin source.
 *
 * Mirrors {@link ensureInstalled}: the ref resolves to a SHA (the immutable
 * cache key), the install runs in a staging sibling and is renamed into place
 * only on success, and a repeat install of the same SHA is a cache hit skipped
 * without touching `git` or `npm`. Between the staging install and the rename —
 * the one window a partial tree is visible — the package name is discovered and
 * the entry point is verified, so a repo that ships no build fails here rather
 * than as a broken plugin at boot.
 * @param deps - injected effects.
 * @param npm - the resolved `npm` binary.
 * @param git - the resolved `git` binary.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param source - the parsed github source (owner, repo, optional ref).
 * @param cacheKey - the entry key the managed cache is stored under (`github:owner/repo`).
 * @param onLine - receives `npm install` output as it arrives.
 * @param priorPackage - the last discovered name, for the cache-hit marker check.
 * @returns the pinned SHA and the discovered package name.
 */
export async function ensureGitInstalled(
  deps: InstallDeps,
  npm: string,
  git: string,
  dshHome: string,
  source: { owner: string; repo: string; ref?: string },
  cacheKey: string,
  onLine?: (line: string) => void,
  priorPackage?: string,
): Promise<GitInstallResult> {
  // Emit progress for the steps npm cannot narrate on its own: resolving the
  // ref is a silent network call, and the cache-hit path runs no npm at all, so
  // without these the UI's install log would sit empty until (or unless) npm
  // itself starts streaming.
  const ref = source.ref ?? 'HEAD'
  onLine?.(`Resolving github:${source.owner}/${source.repo}#${ref}…`)
  const sha = await resolveGitRef(deps, git, source.owner, source.repo, source.ref)
  const dir = managedDir(dshHome, cacheKey, sha)
  // Cache hit: the same commit is already installed and its name is known.
  if (priorPackage !== undefined && deps.exists(join(dir, 'node_modules', ...priorPackage.split('/'), 'package.json'))) {
    onLine?.(`Already installed at ${sha.slice(0, 10)}.`)
    return { version: sha, package: priorPackage }
  }
  onLine?.(`Installing github:${source.owner}/${source.repo} at ${sha.slice(0, 10)}…`)

  const staging = managedStagingDir(dshHome, cacheKey, sha)
  deps.rm(staging)
  deps.mkdir(staging)

  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await runNpm(
      deps,
      npm,
      ['install', '--prefix', staging, `github:${source.owner}/${source.repo}#${sha}`, '--no-audit', '--no-fund'],
      { cwd: dshHome, onLine, timeoutMs: INSTALL_TIMEOUT_MS },
    )
  } catch (error) {
    deps.rm(staging)
    throw error
  }
  if (result.code !== 0) {
    deps.rm(staging)
    throw new Error(`dsh-desktop: npm install github:${source.owner}/${source.repo}#${sha} failed:\n${result.stderr}`)
  }

  let pkg: string
  try {
    pkg = discoverInstalledPackage(deps, staging)
    assertPluginBuilt(deps, staging, pkg)
  } catch (error) {
    deps.rm(staging)
    throw error
  }
  onLine?.(`Installed ${pkg} at ${sha.slice(0, 10)}.`)

  deps.rm(dir)
  deps.rename(staging, dir)
  return { version: sha, package: pkg }
}
