import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { managedDir } from './harness-source'
import { DEFAULT_PLUGIN_SPECS } from './plugin-defaults'
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
 *
 * `config` is the entry's own free-form configuration, passed to the cordis
 * overlay's `insert.config` verbatim. Only the plugin itself knows its
 * schema, so this is deliberately untyped beyond "a JSON object" — validated
 * by `settings-validate.ts`'s `parsePluginConfig` before it is ever stored,
 * and re-validated in `config.ts`'s `parseConfig` for a hand-edited
 * `desktop.json`. Absent means the entry gets the overlay's empty `{}`.
 */
export interface PluginEntry {
  spec: string
  version?: string
  config?: Record<string, unknown>
}

/** The plugin list a fresh, never-configured install starts from. */
export function defaultPlugins(): PluginEntry[] {
  return [{ spec: HOOKS_PACKAGE }, ...DEFAULT_PLUGIN_SPECS.map((spec) => ({ spec }))]
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
 * Shape of a valid (optionally scoped) npm package name.
 * Deliberately narrower than npm's full grammar: it exists to keep a spec
 * from reaching `packageDirIn`'s raw `join(..., ...pkg.split('/'))` as a
 * path-traversal or multi-segment string, not to validate every legal npm
 * name.
 */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Shape of a valid version (e.g. `1.2.3`, `0.1.1-rc.2`). Like
 * `PACKAGE_NAME_PATTERN`, this exists to keep a pinned version from reaching
 * `managedDir` as a traversal or multi-segment string.
 */
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/

/**
 * Whether a spec's package name and, if present, its pinned version are
 * shaped safely enough to reach `managedDir`/`packageDirIn`.
 *
 * The Settings form validates a freshly typed spec before it is ever stored
 * (see `settings-validate.ts`'s `parsePluginsField`), but a `desktop.json`
 * can also be hand-edited directly — `config.ts`'s `parseConfig` calls this
 * too, so a spec that reaches `pluginStatus`/`resolvePluginEntry` has always
 * passed through here, regardless of which path it arrived by.
 * @param spec - as typed or as stored, e.g. `@onetest/dsh-deck@0.2.1`.
 * @returns whether the spec is safe to store and later resolve.
 */
export function validSpecShape(spec: string): boolean {
  const { package: pkg, pinnedVersion } = parseSpec(spec)
  if (!PACKAGE_NAME_PATTERN.test(pkg)) return false
  return pinnedVersion === undefined || VERSION_PATTERN.test(pinnedVersion)
}

/**
 * The directory a scoped or unscoped package occupies inside an
 * `npm install --prefix <installDir>` tree.
 * @param installDir - the `npm install --prefix` directory.
 * @param pkg - the package name.
 * @returns the package's own directory under `installDir/node_modules`.
 */
export function packageDirIn(installDir: string, pkg: string): string {
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

/**
 * The `package.json` fields this module reads: `main`/`exports` for
 * `resolvePluginEntry`, and the `dsh` namespace a plugin uses to declare
 * three optional, independent things about itself — a browser half
 * (`dsh.client.platform`), a directory of agent presets to install
 * (`dsh.presets`), and how it wants to be mounted into the harness overlay
 * (`dsh.bundle.patch`), the same field name the harness's own profile
 * composer reads for a `dsh.profile.bundles` layer (see
 * `packages/boot/app-boot/src/profile.ts` in the deepseek-harness repo).
 * All three are opt-in: their absence means exactly what it says (no
 * browser half; nothing to install; synthesize the mount), never "unknown,
 * so scan for one".
 */
interface EntryManifest {
  main?: string
  exports?: string | Record<string, unknown>
  dsh?: {
    client?: { platform?: string }
    presets?: string
    bundle?: { patch?: string }
  }
}

/**
 * Read and parse a package's own `package.json` from its install directory.
 * @param packageDir - the package's own directory (see `packageDirIn`).
 * @returns the parsed manifest.
 */
function readManifest(packageDir: string): EntryManifest {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as EntryManifest
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
  const manifest = readManifest(packageDir)
  const relative = entryFromExports(manifest.exports) ?? manifest.main
  if (relative === undefined) {
    throw new Error(`${pkg}'s package.json declares no exports["."] or "main" entry (${join(packageDir, 'package.json')})`)
  }
  return join(packageDir, relative)
}

/**
 * Whether an installed package declares a browser half.
 *
 * This is not a nicety: `@deepseek-ai/dsh-client-modules`' `ClientModuleRegistry`
 * discovers every plugin's browser bundle by resolving the cordis overlay's
 * own insert `name` as a package specifier (`require.resolve(\`${name}/package.json\`)`
 * against the profile's `cordis.yml`) — never by scanning installed packages
 * on its own. A package this returns `true` for has no other way to be
 * found: if its overlay `name` cannot resolve as a specifier (an absolute
 * path, or anything else that is not the package's own name reachable from
 * the profile's `node_modules`), the registry catches the resolution
 * failure, caches the package as having no client half, and moves on — no
 * error, no log line, nothing the shell's own "Failed to load plugins"
 * screen would ever show. The node half is unaffected, so the plugin's
 * tools keep working while its UI silently never registers.
 * @param packageDir - the package's own directory (see `packageDirIn`).
 * @returns whether `package.json` declares `dsh.client.platform === 'web'`;
 *   `false` (never throws) when the manifest is unreadable or silent on it.
 */
export function declaresClientHalf(packageDir: string): boolean {
  try {
    return readManifest(packageDir).dsh?.client?.platform === 'web'
  } catch {
    return false
  }
}

/**
 * A package's own declared directory of agent presets to install, relative
 * to its own root — e.g. `dsh.presets: "./presets"` resolving to
 * `<packageDir>/presets`.
 *
 * Deliberately opt-in, read from the manifest rather than inferred by
 * scanning: a package that never declared this field must never have
 * arbitrary directories copied out of it (see `plugin-presets.ts`'s
 * `ensurePluginPresets`) just because one of them happens to contain a
 * `preset.yml`.
 * @param packageDir - the package's own directory (see `packageDirIn`).
 * @returns the declared relative path, or undefined when the manifest is
 *   unreadable or does not declare one.
 */
export function presetsDeclaration(packageDir: string): string | undefined {
  try {
    return readManifest(packageDir).dsh?.presets
  } catch {
    return undefined
  }
}

/**
 * A package's own declared bundle patch file, relative to its own root —
 * e.g. `dsh.bundle.patch: "./cordis.patch.yml"` resolving to
 * `<packageDir>/cordis.patch.yml`.
 *
 * Deliberately opt-in, read from the manifest rather than inferred by
 * scanning: a package that never declared this field keeps today's
 * synthesized overlay row (`runtime-files.ts`'s `patchOverlay`) unchanged,
 * exactly like `presetsDeclaration` above for agent presets.
 * @param packageDir - the package's own directory (see `packageDirIn`).
 * @returns the declared relative path, or undefined when the manifest is
 *   unreadable or does not declare one.
 */
export function bundlePatchDeclaration(packageDir: string): string | undefined {
  try {
    return readManifest(packageDir).dsh?.bundle?.patch
  } catch {
    return undefined
  }
}

/**
 * Whether, and where, a plugin entry can be mounted into the harness the app
 * is about to boot.
 *
 * `ready` carries the absolute entry file the cordis overlay's `insert` must
 * point at when it cannot be linked by name — the cordis loader resolves a
 * directory `name` by looking only for `index.jsx` and ignores
 * `package.json`, so a package directory does not work there, only its entry
 * file does — plus the directory the loadability probe should check from,
 * and the package's own directory under the managed install (`packageDir`),
 * which `plugin-link.ts` symlinks into the profile's `node_modules` so the
 * overlay can refer to the entry by bare package name instead. `unavailable`
 * carries why the entry cannot be mounted, surfaced by the caller instead of
 * blocking boot.
 *
 * `config` carries the entry's own stored configuration, when set; `configPath`
 * is a separate, privileged override used only for the hook bridge and takes
 * precedence over `config` in `patchOverlay` — the two are never both
 * meaningful for the same entry today, but are kept distinct because they
 * come from different sources (an entry's own stored `config` vs. a path this
 * app generates).
 */
export type PluginStatus =
  | {
      kind: 'ready'
      package: string
      entryPath: string
      probeDirectory: string
      packageDir: string
      configPath?: string
      config?: Record<string, unknown>
    }
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
    // No instruction here any more: startup repairs what the config declares
    // before the harness boots, so telling the user to save Settings would be
    // advice for a state the app resolves on its own.
    return { kind: 'unavailable', package: pkg, reason: `${pkg} is not installed yet.` }
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
      packageDir: packageDirIn(installDir, pkg),
      configPath,
      config: entry.config,
    }
  } catch (error) {
    return { kind: 'unavailable', package: pkg, reason: (error as Error).message }
  }
}
