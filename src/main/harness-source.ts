import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the harness runtime comes from. */
export type HarnessSource =
  | { kind: 'local'; repo: string }
  | { kind: 'managed'; package: string; version: string; workspace: string }

/**
 * Binary resolvers used to launch each source kind.
 *
 * Each is a thunk, not a resolved string, so `spawnFor` can call only the one
 * its chosen branch needs. Resolution can throw (see `resolveBinary`), and
 * eagerly resolving both before picking a branch would let the *unused*
 * launcher's failure veto a source that never needed it.
 */
export interface Launchers {
  pnpm(): string
}

/** Spawn specification shared with `server.ts`. */
export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

/** The harness home directory name, mirroring `dsh`'s own convention. */
const HOME_DIR_NAME = '.dsh'

/** Folder under `$DSH_HOME` holding one directory per installed managed version. */
const RUNTIMES_DIR_NAME = 'runtimes'

/**
 * Resolve `$DSH_HOME`, matching the harness's own `resolveDshHome`
 * (packages/util/home-paths): trimming only decides whether the value counts
 * as set; the value used is the original, untrimmed string.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the resolved harness home directory.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv): string {
  const raw = env.DSH_HOME
  const isSet = raw !== undefined && raw.trim().length > 0
  return isSet ? raw : join(homedir(), HOME_DIR_NAME)
}

/**
 * Absolute path of the desktop config file.
 * Lives under `$DSH_HOME` so a packaged app — which cannot edit its own
 * bundle — reads the same location the harness itself uses.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the config file path.
 */
export function configPath(env: NodeJS.ProcessEnv): string {
  return join(resolveDshHome(env), 'desktop.json')
}

/**
 * Directory holding one installed version of a managed package.
 *
 * The package name contains a slash (`@deepseek-ai/dsh`), which cannot go
 * into a single path segment raw, and a naively substituted separator (e.g.
 * `/` → `-`) could let two distinct package names collide on the same
 * directory (`@a/b` and `@a-b`). Each of `package` and `version` is instead
 * `encodeURIComponent`-escaped into its own path segment: percent-encoding
 * is injective (distinct inputs never produce equal output) and escapes `/`
 * to `%2F`, so no segment can itself contain a path separator. Nesting the
 * two segments (rather than joining them into one with a hand-chosen
 * delimiter) sidesteps needing that delimiter to be unambiguous too.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param pkg - the package name, e.g. `@deepseek-ai/dsh`.
 * @param version - the installed version or dist-tag.
 * @returns the directory an `npm install --prefix` for this package/version targets.
 */
export function managedDir(dshHome: string, pkg: string, version: string): string {
  return join(dshHome, RUNTIMES_DIR_NAME, encodeURIComponent(pkg), encodeURIComponent(version))
}

/**
 * The `dsh` executable inside a managed install directory.
 *
 * The published package declares `"bin": { "dsh": "lib/bin.js" }`, so
 * `npm install --prefix <dir>` links a launcher at this path.
 * @param dir - a directory returned by `managedDir`.
 * @returns the absolute path to the installed `dsh` binary.
 */
export function managedBin(dir: string): string {
  return join(dir, 'node_modules', '.bin', 'dsh')
}

/**
 * Build the spawn specification for a source.
 *
 * The launcher's own flags precede the profile in both modes: `dsh` treats the
 * first token it does not recognize as the start of the inner arguments, so
 * `dsh web --patch F` fails with `unknown option '--patch'`.
 * @param source - configured harness source.
 * @param launchers - the pnpm binary resolver; only called for a local source.
 * @param patchFile - absolute path to the cordis patch overlay.
 * @param dshHome - the resolved `$DSH_HOME` directory, used to locate a managed install.
 * @returns command, arguments, and working directory.
 */
export function spawnFor(source: HarnessSource, launchers: Launchers, patchFile: string, dshHome: string): SpawnSpec {
  const profileArgs = ['--profile', 'web', '--patch', patchFile, '--no-open']
  if (source.kind === 'local') {
    return { command: launchers.pnpm(), args: ['dsh', ...profileArgs], cwd: source.repo }
  }
  return {
    command: managedBin(managedDir(dshHome, source.package, source.version)),
    args: profileArgs,
    cwd: source.workspace,
  }
}
