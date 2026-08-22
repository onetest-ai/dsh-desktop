import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { managedDir } from './harness-source'
import { isInstalled, type InstallDeps } from './runtime-install'

/** The Claude Code hook bridge package, pre-seeded as the first plugin entry. */
export const HOOKS_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

/**
 * One package the desktop shell installs and inserts into the harness,
 * managed exactly like the core `@deepseek-ai/dsh` package — pinned, cached,
 * update-checked.
 *
 * `spec` is stored as the user typed it (`pkg` or `pkg@version`) because
 * whether the entry is pinned cannot be recovered from `version` alone: both
 * a pinned and a floating entry end up with a concrete installed version.
 * `version` is the concrete, resolved, installed version — never a dist-tag
 * — absent until a save has installed the entry at least once. The field is
 * optional so a `desktop.json` predating plugins, or with an entry that has
 * never successfully installed, stays valid.
 */
export interface PluginEntry {
  spec: string
  version?: string
}

/** The plugin list a fresh, never-configured install starts from. */
export function defaultPlugins(): PluginEntry[] {
  return [{ spec: HOOKS_PACKAGE }]
}

/** A spec's package name and, when present, the pinned version it named. */
export interface ParsedSpec {
  package: string
  /** Set when the spec carried `@version` — the entry is pinned. */
  pinnedVersion?: string
}

/**
 * Parse a command-line-style package spec into its package name and, when
 * present, a pinned version.
 *
 * A scoped package's own leading `@scope/` is not a version separator, so
 * the search for the version-introducing `@` starts after it.
 * @param spec - as typed, e.g. `@onetest/dsh-deck@0.2.1` or `@onetest/dsh-deck`.
 * @returns the parsed package name and pinned version.
 */
export function parseSpec(spec: string): ParsedSpec {
  const searchFrom = spec.startsWith('@') ? 1 : 0
  const at = spec.indexOf('@', searchFrom)
  if (at === -1) return { package: spec }
  return { package: spec.slice(0, at), pinnedVersion: spec.slice(at + 1) }
}

/**
 * The directory a scoped or unscoped package occupies inside an
 * `npm install --prefix <installDir>` tree.
 * @param installDir - the `npm install --prefix` directory.
 * @param pkg - the package name.
 * @returns the package's own directory under `installDir/node_modules`.
 */
function packageDirIn(installDir: string, pkg: string): string {
  return join(installDir, 'node_modules', ...pkg.split('/'))
}

/**
 * The path `isInstalled`/`ensureInstalled` treat as proof a plugin entry's
 * install is complete.
 *
 * A plugin entry declares no `bin`, so the default `managedBin` marker
 * (`node_modules/.bin/dsh`) never exists for it and would report every
 * install as incomplete forever, forcing a reinstall on every save. Its own
 * `package.json` landing in place is the entry's completion signal instead:
 * `ensureInstalled` renames the staging directory into place only after
 * `npm install` has fully succeeded, so nothing partial can produce it.
 * @param installDir - the `npm install --prefix` directory.
 * @param pkg - the package name.
 * @returns the marker path for `isInstalled`/`ensureInstalled`.
 */
export function pluginInstallMarker(installDir: string, pkg: string): string {
  return join(packageDirIn(installDir, pkg), 'package.json')
}

/** The `package.json` fields `resolvePluginEntry` reads. */
interface EntryManifest {
  main?: string
  exports?: string | Record<string, unknown>
}

/**
 * Pick the entry subpath out of a package's `exports` field: the root (`.`)
 * export, as a bare string or as a conditions object, preferring
 * `default`/`import`/`require`/`node` in that order.
 * @param exportsField - the `package.json` `exports` value, if any.
 * @returns the entry subpath, or undefined when `exports` names none.
 */
function entryFromExports(exportsField: EntryManifest['exports']): string | undefined {
  if (typeof exportsField === 'string') return exportsField
  if (exportsField === undefined || exportsField === null || typeof exportsField !== 'object') return undefined
  const dot = (exportsField as Record<string, unknown>)['.']
  if (typeof dot === 'string') return dot
  if (typeof dot === 'object' && dot !== null) {
    const conditions = dot as Record<string, unknown>
    const value = conditions.default ?? conditions.import ?? conditions.require ?? conditions.node
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Resolve the absolute entry file of an installed package from its own
 * `package.json`: `exports["."]` first, falling back to `main`.
 *
 * Deliberately reads the manifest rather than hardcoding `lib/index.js`: the
 * published entry subpath is the package's own declared contract, not a
 * convention this app should assume stays fixed.
 * @param installDir - the `npm install --prefix` directory the package was installed into.
 * @param pkg - the package name.
 * @returns the absolute path to the package's entry file.
 */
export function resolvePluginEntry(installDir: string, pkg: string): string {
  const packageDir = packageDirIn(installDir, pkg)
  const manifestPath = join(packageDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EntryManifest
  const relative = entryFromExports(manifest.exports) ?? manifest.main
  if (relative === undefined) {
    throw new Error(`${pkg}'s package.json declares no exports["."] or "main" entry (${manifestPath})`)
  }
  return join(packageDir, relative)
}

/**
 * Whether, and where, a plugin entry can be mounted into the harness the app
 * is about to boot.
 *
 * `ready` carries the absolute entry file the cordis overlay's `insert` must
 * point at — the cordis loader resolves a directory `name` by looking only
 * for `index.jsx` and ignores `package.json`, so a package directory does
 * not work there, only its entry file does — plus the directory the
 * loadability probe should check from. `unavailable` carries why the entry
 * cannot be mounted, surfaced by the caller instead of blocking boot.
 */
export type PluginStatus =
  | { kind: 'ready'; package: string; entryPath: string; probeDirectory: string; configPath?: string }
  | { kind: 'unavailable'; package: string; reason: string }

/**
 * Whether an entry's pinned version is installed and its entry file can be
 * resolved, without touching the network or running `npm`.
 *
 * `bootNow` calls this on every boot for every configured entry; only a
 * Settings save installs or updates a plugin (see `settings-ipc.ts`), so
 * this only ever reads what is already on disk.
 * @param deps - injected effects; only `exists` is used, via `isInstalled`.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param entry - the configured entry.
 * @param configPath - set only for the entry the app privileges with its own
 *   generated config — currently the hook bridge's `hooks.json`.
 * @returns ready with the resolved entry, or unavailable with why.
 */
export function pluginStatus(
  deps: InstallDeps,
  dshHome: string,
  entry: PluginEntry,
  configPath?: string,
): PluginStatus {
  const { package: pkg } = parseSpec(entry.spec)
  if (entry.version === undefined) {
    return { kind: 'unavailable', package: pkg, reason: `${pkg} is not installed yet; save Settings once to install it.` }
  }
  const installDir = managedDir(dshHome, pkg, entry.version)
  if (!isInstalled(deps, dshHome, pkg, entry.version, (dir) => pluginInstallMarker(dir, pkg))) {
    return { kind: 'unavailable', package: pkg, reason: `${pkg}@${entry.version} is pinned but not installed at ${installDir}` }
  }
  try {
    return {
      kind: 'ready',
      package: pkg,
      entryPath: resolvePluginEntry(installDir, pkg),
      probeDirectory: installDir,
      configPath,
    }
  } catch (error) {
    return { kind: 'unavailable', package: pkg, reason: (error as Error).message }
  }
}
