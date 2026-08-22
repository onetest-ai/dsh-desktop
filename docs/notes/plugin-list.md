# Plugin list in Settings

## What changed

Settings now carries a generic list of plugin entries — packages the desktop
shell installs into `$DSH_HOME/runtimes/` and inserts into the harness overlay
— managed exactly like the core `@deepseek-ai/dsh` package: pinned, cached,
update-checked. The notification hook bridge
(`@deepseek-ai/dsh-hooks-claude-code`) is no longer a hardcoded special case;
it is the first entry pre-seeded into a fresh config, distinguished from a
generic entry only by the app supplying its `configPath` (the generated
`hooks.json`) when building the overlay.

## Config shape

```ts
interface PluginEntry {
  spec: string      // as typed: "pkg" (floating) or "pkg@version" (pinned)
  version?: string   // concrete, resolved, installed version; absent until installed once
}
interface DesktopConfig {
  // ...
  plugins?: PluginEntry[]
}
```

`spec` is stored as typed because whether an entry is pinned cannot be
recovered from `version` alone — both a pinned and a floating entry end up
with a concrete installed version. `plugins` is optional so a `desktop.json`
predating this field stays valid.

## Entry resolution

`plugin-entries.ts`'s `resolvePluginEntry` reads the installed package's own
`package.json` — `exports["."]` first (string or conditions object,
preferring `default`/`import`/`require`/`node`), falling back to `main` —
never a hardcoded `lib/index.js`. The cordis loader resolves a directory
`name` by looking only for `index.jsx` and ignores `package.json`, so the
overlay's `insert` always points at this resolved entry file.

`pluginStatus` reports `ready` (with the entry path) or `unavailable` (with a
reason) purely from disk, without touching the network — `bootNow` calls it
on every boot; only a Settings save installs anything. `runtime-files.ts`'s
`writeRuntimeFiles` then runs the existing loadability probe
(`checkPackageLoadable`, extended to also resolve `dependencies` and required
`peerDependencies`, not just the entry file) per entry before adding it to the
overlay, so a broken plugin is omitted with its reason surfaced and the
harness still boots.

## Settings UI

A `plugins` textarea (one spec per line) replaces the harness's own dedicated
`hooksBridgeVersion` field. `settings-ipc.ts`'s `performSave` parses the
textarea, reconciles it against the previously stored entries by package name
(carrying forward an already-resolved floating entry's version instead of
re-resolving to `latest` every save), and installs/verifies each entry through
the same `createManagedInstaller`/`ensureInstalled` used for the core package
— `installPlugin` is a second `SettingsDeps` method distinct from
`installManaged` only because a plugin entry links no `bin`, so its
install-complete marker is the installed package's own `package.json` instead
of `node_modules/.bin/dsh`. A failed entry install never fails the save; the
previously resolved version is kept. `read` reports each entry's parsed
package/pinned/version and, for floating entries only, checks for an update
out of band over a new `settings:plugin-update-available` push channel,
mirroring the harness's own update-hint mechanism.

## Peer-dependency finding (anticipated)

`@onetest/dsh-deck`'s own `checkPackageLoadable` probe passed cleanly:
`npm install`ing it standalone did **not** produce a duplicated
`@deepseek-ai/cordis`, so the anticipated identity-break risk did not
materialize for this package. (The note already on this branch, from a
predecessor session's investigation of the hook bridge itself, confirms the
same package's own `@deepseek-ai/dsh-hook-protocol` peer *does* break loading
when omitted — that finding stands, just for the bridge, not for
`@onetest/dsh-deck`.)

## Two new findings, not anticipated in the task

Both blocked end-to-end verification until fixed; both are pre-existing code
this feature was the first to exercise with a scoped package name and a
config-free generic insert.

**1. `managedDir`'s percent-encoding broke every scoped package as an import
specifier.** `encodeSegment` (unchanged since before this feature) percent-
encodes each path segment via `encodeURIComponent`, which turns a scoped
package's `/` into a literal `%2F`. A plugin's resolved entry file is passed
to the cordis loader as an absolute-path `import()` specifier, and Node's ESM
resolver treats a bare absolute path specifier as a URL reference: it reads a
literal `%2F`/`%5C` substring as a disguised path separator and refuses it
outright (`ERR_INVALID_MODULE_SPECIFIER`); escaping the `%` itself
(`%2F` → `%252F`) only traded that error for `ERR_MODULE_NOT_FOUND`, because
the same URL-reference resolution decodes the specifier's `%`-escapes once
before checking the filesystem, so a double-escaped literal path never lines
up with what is actually on disk. Fixed by replacing `encodeSegment`'s
percent-encoding with `base64url` (RFC 4648 §5): its alphabet
(`A-Za-z0-9-_`) contains no `.`, `/`, or `%`, so no scoped package name can
ever produce a URL-escape-shaped directory segment. This affects every
managed install, including the harness's own — not only plugins — since the
same function backs both.

**2. cordis's config resolution rejects an insert with no `config` key at
all**, not just one with a bad value: `expected a config object`. The
`plugins` decision meant "no *editable per-plugin* config," which I initially
took to mean omitting the YAML `config:` key outright for a generic entry —
that omission itself is what cordis rejected. Fixed by emitting `config: {}`
for every generic entry (only the hook bridge gets a populated `config:
configPath: ...`).

## Vacuity checks

**"The overlay references the entry file, not the directory or a bare
name":** reverted `patchOverlay`'s `yamlScalar(entry.entryPath)` to
`yamlScalar(entry.package)`. Result: 6 of 6 `writeRuntimeFiles`/`patchOverlay`
tests in `runtime-files.spec.ts` failed, each expecting the entry path and
getting the bare package name instead. Restored; suite green again.

**"A pinned entry is never offered an update":** reverted the
`plugin.pinned ||` clause out of `settings-ipc.ts`'s `read` guard (kept only
the `plugin.version === undefined` check). Result:
`read > plugins > never offers an update for a pinned entry` failed —
`checkManagedUpdate` was called once for the pinned entry and its higher
registry version was reported. Restored; suite green again.

## End-to-end evidence

Isolated `DSH_HOME` under `mkdtemp(tmpdir())`, never `~/.dsh`. Installed
`@onetest/dsh-deck` through the shipped `createManagedInstaller` +
`pluginStatus` + `writeRuntimeFiles` path (built `dist/main`, no network stub),
then booted the real local harness checkout (`pnpm dsh --profile web --patch
<generated overlay> --no-open`) against the generated overlay.

- Fresh install (`npm install --prefix`, 38 packages): **1.28s**–4.15s across
  runs (registry-latency-dependent); resolved `latest` → concrete `0.2.1`.
- Re-install of the same concrete version (cache hit via the existing
  `package.json`-marker check): **~200ms**, confirming the shared installer's
  idempotence is preserved for a library-only plugin.
- `checkPackageLoadable('@onetest/dsh-deck', probeDirectory)` → `undefined`
  (loadable): its own `dependencies`/`peerDependencies` all resolved from its
  install directory.
- Generated overlay's `insert` entry: `name` pointed at the resolved
  `lib/index.js`, `config: {}` (no `configPath` — that privilege stays with
  the hook bridge only).
- Booting with the generic no-config overlay reached cordis's own config
  validation for the plugin (`base must be a non-empty string...`) — proof
  the module was found, imported, and reached plugin instantiation, not a
  resolution failure of this feature's own mechanism. `@onetest/dsh-deck`
  itself requires a `base` route-mount config with no default, which the
  "no per-plugin config" design cannot supply; documented above as a
  consequence of that scope decision, not worked around.
- Booting the *same* resolved entry with `config: { base: '/deck' }` supplied
  by the verification script only (not by the shipped app): harness reported
  ready in **3.6s**, and `GET /deck/somefakedeck/` returned HTTP 404 with body
  `"somefakedeck" looks like a deck name, but a deck is addressed by its
  key. Use the route \`deck_view\` returns for this deck.` — text that only
  exists inside `@onetest/dsh-deck`'s own compiled route handler, proving the
  plugin's code actually executed inside the running harness process, not
  merely that the process survived.

`~/.dsh` was temporarily populated (local-source config, `plugins: []`) only
to run the packaged `npm run test:smoke`, which needs a real configured
harness to reach a running URL; removed immediately after. It does not exist
at the end of this work.
