import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { dumpDeclaredPatchRow, type DeclaredPatchRow } from './bundle-patch'
import type { PluginStatus } from './plugin-entries'

export { HOOKS_PACKAGE } from './plugin-entries'

/**
 * One `insert` row actually written to the overlay, tagged with the package
 * that owns it — the exact `id` and `name` the cordis loader was given,
 * captured where the row is built (`patchOverlay`) rather than re-derived
 * from either value afterwards. A synthesized row contributes one; a
 * package's own declared bundle patch (`bundle-patch.ts`) contributes one
 * per row it declares, every one tagged with the same owning package.
 * Consulted only by `attributeBootFailure`.
 */
export interface AttributionRow {
  /** The configured plugin this row belongs to. */
  package: string
  /** The row's `id` in the overlay, verbatim — synthesized or declared. */
  id: string
  /** The row's `name` in the overlay, verbatim — synthesized or declared. */
  name: string
}

/** Absolute paths of the files generated for one harness launch. */
export interface RuntimeFiles {
  /** Passed to the harness as `--patch`. */
  patchPath: string
  /** Referenced from the overlay as the Claude Code hook bridge's `configPath`. */
  hooksPath: string
  /** Every configured plugin left out of the overlay, and why. Empty when all mounted. */
  omitted: { package: string; reason: string }[]
  /** Every row actually inserted into the overlay, for `attributeBootFailure` to consult. */
  ready: AttributionRow[]
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
 * Whether `dependencyName` is installed and reachable from `fromDirectory`,
 * by walking up the `node_modules` ancestry the same way Node's own module
 * resolution does — checking `<dir>/node_modules/<dependencyName>/package.json`
 * at `fromDirectory` and then at each parent directory in turn — without
 * following the dependency's own `exports`/`main` field.
 *
 * A bare `require.resolve(dependencyName)` answers a different question: does
 * this package expose a root entry point. Plenty of installed, working
 * packages answer no — they publish only subpath exports (e.g.
 * `@modelcontextprotocol/sdk`, which exposes `./client/index.js` but no root
 * `.`) and `require.resolve` throws for them even though the package is
 * correctly installed and every subpath a consumer actually imports resolves
 * fine. This walk instead asks the question `checkPackageLoadable` actually
 * needs answered — is the dependency present in the tree at all — by finding
 * its own manifest directly, which sidesteps `exports` map semantics
 * entirely (including packages whose `exports` map also restricts
 * `<name>/package.json` itself).
 * @param dependencyName - the dependency to look for, e.g. `@modelcontextprotocol/sdk`.
 * @param fromDirectory - directory to start the ancestry walk from.
 * @returns true when the dependency's own `package.json` is found.
 */
function isDependencyInstalled(dependencyName: string, fromDirectory: string): boolean {
  let dir = fromDirectory
  for (;;) {
    if (existsSync(join(dir, 'node_modules', dependencyName, 'package.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
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
 * in its `node_modules`: the `isDependencyInstalled` ancestry walk starts at
 * the package's own directory and checks every ancestor `node_modules` in
 * turn, so a peer the profile's own dependency tree hoists to a shared,
 * higher `node_modules` (which is how the profile installs these
 * host-provided packages) still resolves from there. A peer that cannot be
 * found by that walk is one nothing in the profile provides, at any level —
 * which is exactly the class of break this probe exists to catch.
 *
 * Each dependency and required peer is checked with `isDependencyInstalled`,
 * not `require.resolve`: the latter follows the dependency's own
 * `exports`/`main` field to a root entry point, which a subpath-only package
 * (one that publishes only `./sub` exports and no `.`) legitimately does not
 * have, even when fully installed and working. `isDependencyInstalled`
 * instead looks for the dependency's own `package.json` directly, which
 * answers "is this dependency installed and reachable" without depending on
 * whether it happens to expose a root export.
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
      if (!isDependencyInstalled(dependency, packageDir)) {
        return `${packageName} depends on ${dependency}, which is not resolvable: no package.json found for ${dependency} in any node_modules ancestor of ${packageDir}`
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
export function insertId(pkg: string): string {
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
 *
 * An entry whose package declared its own bundle patch (`declaredPatch`,
 * from `bundle-patch.ts`'s `loadDeclaredPatchRows`) contributes that
 * package's own row(s) — its own `id`, `name`, and every other field it
 * declared (e.g. `disabled`) — instead of a synthesized single row. This is
 * skipped, falling back to the synthesized row, in two cases: `configPath`
 * is set (the privileged override reserved for the hook bridge, which never
 * declares a bundle patch in practice, but a synthesized row is the only
 * form that knows how to carry it), or applying the declared rows would
 * collide — a duplicate id within the same declared patch, or an id already
 * used by an earlier entry or the reserved `webserver` id. A collision is
 * treated the same as a malformed patch: the one package's mount degrades
 * to its synthesized row rather than risking two `insert` entries sharing
 * one id, which the cordis loader would reject outright and take the whole
 * overlay down with it.
 *
 * Config precedence for a declared row matching the package's own name
 * (`row.name === entry.package`, i.e. the row that mounts the package
 * itself rather than a companion row the patch also declares): the user's
 * own stored `config` (`entry.config`), when set, replaces the row's
 * declared `config` outright — never merged, matching the harness's own
 * documented rule that "a patch replaces a row's whole `config`; there is
 * no deep-merge layer" (`packages/bundle/base/README.md`). With no stored
 * user config, the package's own declared default config is kept verbatim
 * — the point of this feature: a fresh install needs no hand-typed config
 * at all when the package ships its own default.
 * Every row emitted — declared or synthesized — is also captured as an
 * `AttributionRow` tagged with its owning package, using the exact `id`
 * and `name` written to the overlay rather than a value re-derived from
 * either afterwards; `attributeBootFailure` consults these later to
 * attribute a boot failure back to the one entry that caused it.
 * @param ready - plugin entries confirmed loadable, in configured order.
 * @param omitted - entries left out, and why.
 * @returns the overlay document, plus every row it actually inserted.
 */
export function patchOverlay(
  ready: {
    package: string
    entryPath: string
    name: string
    configPath?: string
    config?: Record<string, unknown>
    declaredPatch?: DeclaredPatchRow[]
  }[],
  omitted: { package: string; reason: string }[],
): { overlay: string; rows: AttributionRow[] } {
  const webserver = `# Generated by dsh-desktop at launch; edits are overwritten on the next boot.
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
`
  const comments = omitted
    .map((entry) => `# ${entry.package} was omitted: ${entry.reason.replaceAll('\n', ' ')}\n`)
    .join('')

  if (ready.length === 0) return { overlay: `${webserver}\n${comments}`, rows: [] }

  // Each `name` is either the plugin's bare package name — when
  // `plugin-link.ts` has symlinked it into the profile's `node_modules` —
  // or, when linking was skipped or failed, the plugin's own resolved
  // absolute entry file. This is not a display preference: cordis's own
  // loader accepts either form (an `import()` resolves both), but
  // `@deepseek-ai/dsh-client-modules`' `ClientModuleRegistry` discovers a
  // plugin's browser bundle only by resolving `name` as a package specifier
  // — `require.resolve(name + '/package.json')` against the profile's own
  // `cordis.yml`. An absolute path is not a valid specifier there, so a
  // path-based `name` silently drops the plugin's entire browser half: no
  // error, nothing in the shell's own "Failed to load plugins" screen, just
  // a plugin whose tools work and whose UI never appears. The bare-name
  // form is therefore the only complete mount; the path form is a
  // last-resort fallback for when linking genuinely cannot happen (see
  // `plugin-link.ts`'s `ensurePluginLink`), not an equivalent alternative.
  // Never the install directory: the cordis loader resolves a directory
  // `name` by looking only for `index.jsx` and ignores `package.json`, so
  // only a bare package name (resolved via `node_modules`) or the entry
  // file itself works here.
  //
  // `config` is always present, even for a generic entry with nothing to
  // configure: cordis's own config resolution rejects an insert with no
  // `config` node at all ("expected a config object"), reproduced live
  // booting the real harness against `@onetest/dsh-deck` (see
  // `docs/notes/plugin-list.md`) — an omitted key is not the same as an
  // empty object to it. `configPath` is the privileged override generated
  // for the hook bridge and wins when set; otherwise an entry's own stored
  // `config` (validated JSON object — see `plugin-entries.ts`'s
  // `PluginEntry`) is emitted as a flow-style YAML mapping, which is valid
  // YAML for any JSON value; an entry with neither gets `{}`.
  // Reserves the webserver row's own id so a declared patch can never
  // collide with it; every entry below adds its own id (declared or
  // synthesized) as it is emitted.
  const usedIds = new Set<string>(['webserver'])
  const rows: AttributionRow[] = []
  const inserts = ready
    .map((entry) => {
      if (entry.configPath === undefined && entry.declaredPatch !== undefined && entry.declaredPatch.length > 0) {
        const ids = entry.declaredPatch.map((row) => row.id)
        const collides = new Set(ids).size !== ids.length || ids.some((id) => usedIds.has(id))
        if (!collides) {
          for (const id of ids) usedIds.add(id)
          return entry.declaredPatch
            .map((row) => {
              const withConfig =
                entry.config !== undefined && row.name === entry.package ? { ...row, config: entry.config } : row
              rows.push({ package: entry.package, id: row.id, name: row.name })
              return dumpDeclaredPatchRow(withConfig)
            })
            .join('')
        }
      }
      const id = insertId(entry.package)
      usedIds.add(id)
      rows.push({ package: entry.package, id, name: entry.name })
      const config =
        entry.configPath !== undefined
          ? `\n      config:\n        configPath: ${yamlScalar(entry.configPath)}`
          : entry.config !== undefined
            ? `\n      config: ${JSON.stringify(entry.config)}`
            : '\n      config: {}'
      return `    - id: ${id}\n      name: ${yamlScalar(entry.name)}${config}\n`
    })
    .join('')

  return {
    overlay: `${webserver}
- insert:
${inserts}
${comments}`,
    rows,
  }
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
 * @param resolveName - the overlay's insert `name` for a ready, loadable
 *   entry — the production caller (`index.ts`) supplies one that links the
 *   entry into the profile's `node_modules` and returns the bare package
 *   name on success, falling back to `status.entryPath` on failure; defaults
 *   to the path-only behaviour so every other caller (including tests) that
 *   does not pass one keeps working unchanged.
 * @param resolveDeclaredPatch - the rows a ready entry's own `dsh.bundle.patch`
 *   declares, if any — the production caller supplies one that reads
 *   `plugin-entries.ts`'s `bundlePatchDeclaration` and, when set, parses it
 *   with `bundle-patch.ts`'s `loadDeclaredPatchRows`; defaults to `undefined`
 *   for every entry so every other caller (including tests) that does not
 *   pass one keeps synthesizing a row unchanged.
 * @returns the absolute paths of the generated files, and which plugins were
 *   omitted, if any.
 */
export function writeRuntimeFiles(
  directory: string,
  notifyPort: number,
  statuses: PluginStatus[],
  probe: LoadabilityProbe = checkPackageLoadable,
  resolveName: (status: Extract<PluginStatus, { kind: 'ready' }>) => string = (status) => status.entryPath,
  resolveDeclaredPatch: (status: Extract<PluginStatus, { kind: 'ready' }>) => DeclaredPatchRow[] | undefined = () => undefined,
): RuntimeFiles {
  const omitted: { package: string; reason: string }[] = []
  const ready: {
    package: string
    entryPath: string
    name: string
    configPath?: string
    config?: Record<string, unknown>
    declaredPatch?: DeclaredPatchRow[]
  }[] = []
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
    ready.push({
      package: status.package,
      entryPath: status.entryPath,
      name: resolveName(status),
      configPath: status.configPath,
      config: status.config,
      declaredPatch: resolveDeclaredPatch(status),
    })
  }

  const built = patchOverlay(ready, omitted)
  const paths = runtimeFilePaths(directory)
  const files: RuntimeFiles = {
    ...paths,
    omitted,
    ready: built.rows,
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(files.hooksPath, hooksConfig(notifyPort))
  writeFileSync(files.patchPath, built.overlay)
  return files
}

/**
 * Attribute a harness boot failure to the one configured plugin that caused
 * it, by matching the harness's own error text against every row actually
 * inserted into the overlay for the failed attempt.
 *
 * The harness's own error names the failing insert two ways: `failed to
 * apply loader entry <id> (<name>): …`, where `<id>` is the row's overlay id
 * and `<name>` is the row's overlay `name` — either the plugin's bare
 * package specifier (linked by name; see `docs/notes/plugin-link-by-name.md`),
 * its resolved absolute entry file (linking skipped or failed), or a
 * package's own declared bundle-patch row's `name` (`bundle-patch.ts`).
 *
 * Matching prefers `(<name>)`: every row's `name` is unique by construction
 * — a package specifier is globally unique, an absolute entry path is
 * unique to its install directory, and a declared row's own `name` is the
 * package specifier it mounts. A row's `id`, by contrast, is not reliably
 * unique: `insertId` collapses every character outside `[a-zA-Z0-9]` to
 * `-`, so two distinct scoped package names can sanitize to the same id
 * (`@a-b/c` and `@a/b-c` both become `a-b-c`) — the collision that made an
 * earlier version of this function match on the resolved entry path
 * instead, which broke once linking by name made a plugin's overlay `name`
 * diverge from its `entryPath`. `id` is therefore consulted only as a
 * fallback, anchored to the `entry <id> ` phrase so it cannot match a
 * substring of an unrelated word, and only when no `name` matched — this is
 * what lets a package's own declared row (e.g. `deck` for `@onetest/dsh-deck`,
 * an id that is neither the package name nor `insertId`'s derived one)
 * still attribute correctly using the id `bundle-patch.ts` actually declared,
 * carried here from generation rather than re-derived from the message.
 *
 * Exactly one attributed package is required at each stage: a message that
 * matches zero or more than one row's `name` (or, having matched no name, more
 * than one row's `id`) is unattributable, since guessing which of several
 * candidates actually broke would risk dropping a healthy plugin while
 * leaving the real cause running.
 * @param message - the harness's own failure text.
 * @param ready - the rows actually inserted into the overlay for the
 *   attempt that failed.
 * @returns the one package the failure is attributed to, or undefined when
 *   the message cannot be attributed to exactly one of them.
 */
export function attributeBootFailure(message: string, ready: AttributionRow[]): string | undefined {
  const byName = new Set(ready.filter((row) => message.includes(`(${row.name})`)).map((row) => row.package))
  if (byName.size > 0) return byName.size === 1 ? [...byName][0] : undefined

  const byId = new Set(ready.filter((row) => message.includes(`entry ${row.id} `)).map((row) => row.package))
  return byId.size === 1 ? [...byId][0] : undefined
}
