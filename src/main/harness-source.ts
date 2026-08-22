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
 * Encode a string into a single path segment that cannot be `.`, `..`,
 * empty, or contain a `/` — and, unlike percent-encoding, contains no `%`
 * either.
 *
 * A plugin entry file's absolute path is passed straight to the cordis
 * loader as an `import()` specifier (see `plugin-entries.ts`'s
 * `resolvePluginEntry`), and Node's ESM resolver treats a bare absolute path
 * specifier as a URL reference rather than a raw filesystem path: `%XX`
 * substrings in it are read as percent-escapes and decoded during
 * resolution, and a literal `%2F` or `%5C` — exactly what `encodeURIComponent`
 * emits for a scoped package's `/` — is refused outright as a disguised path
 * separator (`ERR_INVALID_MODULE_SPECIFIER`). No amount of re-escaping `%`
 * itself survives this: the decode happens as part of ordinary URL
 * resolution, not `decodeURIComponent`, so an escaped-`%` scheme round-trips
 * incorrectly and the loader ends up looking for a directory that was never
 * created (`ERR_MODULE_NOT_FOUND`) instead of the one this function wrote to
 * disk. The segment therefore avoids `%` entirely rather than trying to
 * out-escape it.
 *
 * `base64url` (RFC 4648 §5) does that: its alphabet is `A-Za-z0-9-_`, none of
 * which is `.`, `/`, or `%`, so the result can never be `.`, `..`, contain a
 * `/`, or be misread as a URL escape — for any input, hostile or not — and
 * the encoding is a lossless, injective map (invertible by base64url-decoding
 * back to the original UTF-8 bytes). An empty input encodes to the empty
 * string, which is not a valid path segment, so it is padded to `00` — not a
 * genuine encoding, just two characters unreachable from any non-empty input
 * (`base64url` never emits a bare unpadded `00`) or the empty one.
 * @param value - the string to place into one path segment.
 * @returns a segment safe to `path.join` without traversal, collision, or
 *   import-specifier risk.
 */
function encodeSegment(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64url')
  return encoded === '' ? '00' : encoded
}

/**
 * Directory holding one installed version of a managed package.
 *
 * The package name contains a slash (`@deepseek-ai/dsh`), which cannot go
 * into a single path segment raw, and a naively substituted separator (e.g.
 * `/` → `-`) could let two distinct package names collide on the same
 * directory (`@a/b` and `@a-b`). Each of `package` and `version` is instead
 * run through `encodeSegment` into its own path segment — see there for why
 * that is traversal-safe and injective for any input, including a
 * dot-segment like `..` or `../b/1.0.0`. Nesting the two segments (rather
 * than joining them into one with a hand-chosen delimiter) sidesteps needing
 * that delimiter to be unambiguous too.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param pkg - the package name, e.g. `@deepseek-ai/dsh`.
 * @param version - the installed version or dist-tag.
 * @returns the directory an `npm install --prefix` for this package/version targets.
 */
export function managedDir(dshHome: string, pkg: string, version: string): string {
  return join(dshHome, RUNTIMES_DIR_NAME, encodeSegment(pkg), encodeSegment(version))
}

/**
 * Directory an in-progress `npm install` writes into, before it is moved into
 * place as `managedDir`.
 *
 * Installing straight into the final directory means a killed install — the
 * quit path reaping `npm` mid-run, or the install timing out — leaves a
 * half-written tree where a complete one is expected. `isInstalled` checks the
 * linked binary rather than the directory, but `node_modules/.bin/dsh` is
 * linked before the dependency tree is fully written, so that check alone
 * cannot tell a killed install from a finished one. Staging elsewhere and
 * renaming makes the final directory appear only once the install has
 * succeeded, which is a filesystem-atomic step rather than a check.
 *
 * The suffix cannot collide with a real version's directory: `encodeSegment`'s
 * `base64url` alphabet (`A-Za-z0-9-_`) contains no `.`, so no encoded segment
 * ever contains a literal dot, let alone ends with `.partial`.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param pkg - the package name.
 * @param version - the exact version being installed.
 * @returns a sibling of `managedDir` holding the in-progress install.
 */
export function managedStagingDir(dshHome: string, pkg: string, version: string): string {
  return `${managedDir(dshHome, pkg, version)}.partial`
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
