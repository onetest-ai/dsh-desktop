import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { PluginStatus } from './plugin-entries'

export { HOOKS_PACKAGE } from './plugin-entries'

/** Absolute paths of the files generated for one harness launch. */
export interface RuntimeFiles {
  /** Passed to the harness as `--patch`. */
  patchPath: string
  /** Referenced from the overlay as the Claude Code hook bridge's `configPath`. */
  hooksPath: string
  /** Every configured plugin left out of the overlay, and why. Empty when all mounted. */
  omitted: { package: string; reason: string }[]
}

/** File names inside the runtime directory. */
const PATCH_FILE = 'desktop.patch.yml'
const HOOKS_FILE = 'hooks.json'

/**
 * The absolute paths the generated runtime files will occupy in `directory`,
 * without writing anything — needed before the files exist, e.g. to build
 * the hook bridge's `configPath` ahead of resolving its plugin status.
 * @param directory - the runtime directory a boot writes into.
 * @returns the patch and hooks file paths.
 */
export function runtimeFilePaths(directory: string): { patchPath: string; hooksPath: string } {
  return { patchPath: join(directory, PATCH_FILE), hooksPath: join(directory, HOOKS_FILE) }
}

/**
 * Checks whether a package is loadable from a directory, returning `undefined`
 * when it is or a reason string when it is not. Never throws.
 * @param packageName - the package to check.
 * @param fromDirectory - directory to resolve as if importing from a file in it.
 * @returns undefined when loadable, otherwise the reason it is not.
 */
export type LoadabilityProbe = (packageName: string, fromDirectory: string) => string | undefined

/** The parts of a `package.json` the loadability walk reads. */
interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/**
 * Whether a package resolves — together with everything its own `package.json`
 * declares as a required runtime dependency — from a directory. Never throws.
 *
 * `require.resolve` alone is not enough: it follows the package's own
 * `exports`/`main` field to an entry file, but does not execute that file, so
 * a dependency the entry file imports at runtime — and that turns out to be
 * missing — never surfaces (this is exactly how the hook bridge failed in
 * practice: it imports `@deepseek-ai/dsh-hook-protocol`, declared only as a
 * peer dependency, not as `dependencies`). Both `dependencies` and
 * non-optional `peerDependencies` are therefore resolved too, from the
 * package's own directory, without ever executing the package's code.
 *
 * A peer marked `peerDependenciesMeta[name].optional` is skipped: an absent
 * optional peer is a normal, healthy install, and treating it as a failure
 * would disable a plugin on every install that omits it. A *required* peer
 * that is absent is treated as a hard failure even though some required
 * peers (e.g. `@deepseek-ai/cordis`) are ones the harness host itself
 * provides at runtime rather than ones the plugin's own install step places
 * in its `node_modules`: `require.resolve`'s search walks up through every
 * ancestor `node_modules` starting at the package's own directory, so a peer
 * the profile's own dependency tree hoists to a shared, higher
 * `node_modules` (which is how the profile installs these host-provided
 * packages) still resolves from there. A peer that cannot be found by that
 * walk is one nothing in the profile provides, at any level — which is
 * exactly the class of break this probe exists to catch.
 *
 * The walk covers one level: the plugin's own declared dependencies, not
 * their transitive dependencies. The reproduced failure, and the class of
 * failures a plugin can introduce on its own, are one hop from the entry
 * point — the plugin's own `package.json`. A break two hops down is a
 * mis-published dependency of a dependency, which is outside the plugin's
 * control and would, in practice, also break the harness's own boot far more
 * broadly, so it is not the primary risk this probe is guarding against; a
 * full transitive walk would also make this boot-time check's cost scale
 * with the whole install rather than with the one package this overlay
 * decides whether to mount.
 * @param packageName - the package to check, e.g. `@deepseek-ai/dsh-hooks-claude-code`.
 * @param fromDirectory - directory to resolve as if importing from a file in it.
 * @returns undefined when loadable, otherwise the reason it is not.
 */
export function checkPackageLoadable(packageName: string, fromDirectory: string): string | undefined {
  try {
    const resolve = createRequire(join(fromDirectory, 'noop.cjs')).resolve

    let entry: string
    try {
      entry = resolve(packageName, { paths: [fromDirectory] })
    } catch (error) {
      return `${packageName} is not resolvable from ${fromDirectory}: ${(error as Error).message}`
    }

    // Walk up from the resolved entry file to the nearest package.json: the
    // entry is typically a subpath (e.g. `lib/index.js`), not the package root.
    let dir = dirname(entry)
    let manifestPath: string | undefined
    for (;;) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        manifestPath = candidate
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (manifestPath === undefined) {
      return `${packageName}'s package.json could not be located from its resolved entry ${entry}`
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const packageDir = dirname(manifestPath)
    const requiredPeers = Object.keys(manifest.peerDependencies ?? {}).filter(
      (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
    )
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...requiredPeers]) {
      try {
        resolve(dependency, { paths: [packageDir] })
      } catch (error) {
        return `${packageName} depends on ${dependency}, which is not resolvable: ${(error as Error).message}`
      }
    }
    return undefined
  } catch (error) {
    return `${packageName} loadability could not be determined: ${(error as Error).message}`
  }
}

/**
 * Quote a value as a single-quoted YAML scalar.
 * Absolute paths are machine-specific and may contain spaces or quotes, so they
 * are never interpolated bare.
 * @param value - the scalar to quote.
 * @returns the quoted scalar.
 */
function yamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * A stable, filesystem/YAML-safe insert id for a package name.
 * @param pkg - the package name, e.g. `@onetest/dsh-deck`.
 * @returns the id, e.g. `onetest-dsh-deck`.
 */
function insertId(pkg: string): string {
  return pkg.replaceAll(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * The cordis patch overlay the harness child is launched with.
 *
 * It binds the webserver to an OS-assigned loopback port and inserts every
 * ready plugin entry against its resolved entry file. A missing or broken
 * plugin must cost only that plugin, never the harness's ability to boot at
 * all, so an unready entry is left out of the `insert` list rather than
 * attempted — the reason is recorded as a comment so it can be surfaced
 * rather than silently swallowed.
 * @param ready - plugin entries confirmed loadable, in configured order.
 * @param omitted - entries left out, and why.
 * @returns the overlay document.
 */
export function patchOverlay(
  ready: { package: string; entryPath: string; configPath?: string }[],
  omitted: { package: string; reason: string }[],
): string {
  const webserver = `# Generated by dsh-desktop at launch; edits are overwritten on the next boot.
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
`
  const comments = omitted
    .map((entry) => `# ${entry.package} was omitted: ${entry.reason.replaceAll('\n', ' ')}\n`)
    .join('')

  if (ready.length === 0) return `${webserver}\n${comments}`

  // Each `name` is an absolute path to the plugin's own resolved entry file,
  // not the bare package name or its install directory: the cordis loader
  // resolves a directory `name` by looking only for `index.jsx` and ignores
  // `package.json`, so only the entry file itself works here.
  //
  // `config` is always present, even for a generic entry with nothing to
  // configure: cordis's own config resolution rejects an insert with no
  // `config` node at all ("expected a config object"), reproduced live
  // booting the real harness against `@onetest/dsh-deck` (see
  // `docs/notes/plugin-list.md`) — an omitted key is not the same as an
  // empty object to it. A generic entry gets `{}`; only the entry the app
  // privileges with a `configPath` gets one.
  const inserts = ready
    .map((entry) => {
      const config =
        entry.configPath === undefined
          ? '\n      config: {}'
          : `\n      config:\n        configPath: ${yamlScalar(entry.configPath)}`
      return `    - id: ${insertId(entry.package)}\n      name: ${yamlScalar(entry.entryPath)}${config}\n`
    })
    .join('')

  return `${webserver}
- insert:
${inserts}
${comments}`
}

/**
 * The Claude Code hook config that turns a finished agent turn into a
 * notification ping.
 *
 * The Stop hook must never block the agent: its output feeds `steer()`, so a
 * hook that fails or writes to stdout would drive the agent in a loop. `curl`
 * is bounded, silenced, and `|| true`-guarded so the hook always exits 0 with
 * an empty stdout, whether or not the desktop listener is up.
 * @param notifyPort - the port `startNotifyListener` is bound to.
 * @returns the hook config document.
 */
export function hooksConfig(notifyPort: number): string {
  const command = `curl -s -m 2 -X POST http://127.0.0.1:${String(notifyPort)}/turn-end > /dev/null 2>&1 || true`
  return `${JSON.stringify(
    {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
      },
    },
    undefined,
    2,
  )}\n`
}

/**
 * Write the overlay and hook config the harness child reads at load.
 *
 * Both files carry absolute paths and the configured notification port, so
 * neither can be shipped inside the app bundle: a checked-in copy would pin
 * this machine's paths and one hardcoded port. They are generated per boot
 * into a directory that is writable by construction — a packaged app's own
 * resources are inside `app.asar` and may sit on a read-only volume.
 *
 * `statuses` names where each configured plugin entry would load from, or
 * that it is already known to be unavailable (never installed, or resolved
 * to a version missing from disk — see `plugin-entries.ts`'s `pluginStatus`).
 * For each candidate, `probe` still checks whether it actually loads —
 * together with its own declared dependencies — from its install directory
 * before the insert is added. Either way, an unusable plugin only ever costs
 * its own insert, never the harness's ability to boot: our own overlay must
 * never be able to prevent that.
 * @param directory - writable directory to generate into, created if absent.
 * @param notifyPort - the port the desktop notification listener uses.
 * @param statuses - every configured plugin's resolved status.
 * @param probe - checks whether a plugin is loadable; injectable for tests.
 * @returns the absolute paths of the generated files, and which plugins were
 *   omitted, if any.
 */
export function writeRuntimeFiles(
  directory: string,
  notifyPort: number,
  statuses: PluginStatus[],
  probe: LoadabilityProbe = checkPackageLoadable,
): RuntimeFiles {
  const omitted: { package: string; reason: string }[] = []
  const ready: { package: string; entryPath: string; configPath?: string }[] = []
  for (const status of statuses) {
    if (status.kind === 'unavailable') {
      omitted.push({ package: status.package, reason: status.reason })
      continue
    }
    const reason = probe(status.package, status.probeDirectory)
    if (reason !== undefined) {
      omitted.push({ package: status.package, reason })
      continue
    }
    ready.push({ package: status.package, entryPath: status.entryPath, configPath: status.configPath })
  }

  const paths = runtimeFilePaths(directory)
  const files: RuntimeFiles = { ...paths, omitted }
  mkdirSync(directory, { recursive: true })
  writeFileSync(files.hooksPath, hooksConfig(notifyPort))
  writeFileSync(files.patchPath, patchOverlay(ready, omitted))
  return files
}
