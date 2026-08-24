# Plugin overlay entries reference bare package names, not resolved paths

## Problem

The generated cordis overlay inserted every plugin by its resolved absolute
entry file (`resolvePluginEntry`), e.g.
`/Users/…/.dsh/runtimes/QG9uZXRlc3QvZHNoLWRlY2s/MC4yLjE/node_modules/@onetest/dsh-deck/lib/index.js`.
Everywhere the harness surfaces this plugin — logs, error text, any future
plugin inventory — the user sees that path, base64-encoded directory
segments included, instead of the package name they typed.

## Fix

`src/main/plugin-link.ts` (new) symlinks a ready plugin entry into the
profile's own `node_modules` (`$DSH_HOME/profiles/web/node_modules`, the
same directory `dsh plugin --profile web add` writes real installs into) by
its bare package name, pointing at the managed install's own package
directory (`PluginStatus.packageDir`, added alongside `entryPath` in
`plugin-entries.ts`). `index.ts`'s `attemptBoot` supplies `writeRuntimeFiles`
a `resolveName` callback (new, optional, 5th parameter — default keeps
`entryPath`, so every existing caller and test is unaffected) that attempts
`ensurePluginLink` and returns the bare name on success, `status.entryPath`
otherwise. `patchOverlay` now takes a `name` field per ready entry — the
overlay's insert `name` — kept distinct from `entryPath`, which
`RuntimeFiles.ready` still carries unchanged for `attributeBootFailure`.

Node's own module resolution canonicalizes a symlinked module to its real
path by default (no `--preserve-symlinks`), so the harness's own boot-failure
text still names the same absolute `entryPath` regardless of whether the
overlay referenced the plugin by name or by path — `attributeBootFailure`
needed no change.

### Telling our own link apart from a real install

A path is treated as our own symlink only when `lstatSync` shows it is a
symlink *and* its target resolves under `$DSH_HOME/runtimes`
(`harness-source.ts`'s new `runtimesRoot`) — every link this app ever
creates points directly at a managed install's own package directory there,
and nothing else (`npm install`, `dsh plugin add`) ever writes a symlink
into a profile's `node_modules` at all, let alone one aimed at that root.
Anything else at the link path — a real directory, a plain file, or a
symlink pointing elsewhere — is classified `foreign` and never touched:
`ensurePluginLink` returns `false` for it (falling back to the path-based
overlay reference for that one entry) and `reconcilePluginLinks` skips it
during pruning regardless of the current keep set.

### Reconciliation timing

`reconcilePluginLinks` runs once per boot attempt in `attemptBoot`, right
after every configured entry has gone through `ensurePluginLink` — that is
the only point at which "every plugin this boot's overlay is about to
reference by name" is known. It removes every one of this app's own links
not in that boot's linked set: one for a package no longer configured, and
one whose target directory no longer exists (a runtime removed by other
means). Tying this to every boot rather than only to a Settings save means a
runtime pruned or a version changed outside the app is still cleaned up the
next time the harness starts, not left stale until the user happens to open
Settings.

### Link failure is never fatal

`ensurePluginLink`'s only side effects (`unlinkSync`, `mkdirSync`,
`symlinkSync`) are wrapped in a `try`/`catch` that returns `false` on any
failure — permissions, a read-only `$DSH_HOME`, a name collision. The
caller's `resolveName` falls back to `status.entryPath` exactly as before
this feature existed, so a link failure only ever costs the plugin's display
name, never its ability to load.

## Tests

`src/main/plugin-link.spec.ts` (new, 9 tests) covers: linking by bare name;
leaving a real, non-symlink install untouched (with a sentinel file proving
its contents survive); repointing on a version change; removing the link for
a plugin dropped from configuration; falling back (not throwing) when
linking fails (a chmod'd read-only `node_modules` parent); cleaning up a
symlink whose target runtime directory was removed; keeping a link still in
the keep set; and never touching a real directory or a foreign symlink
during reconciliation.

`plugin-entries.spec.ts` and `runtime-files.spec.ts` were updated for the new
`packageDir`/`name` fields; `runtime-files.spec.ts` gained a test proving
`patchOverlay` emits a `name` distinct from `entryPath` when linking
succeeded. `index.spec.ts` assertions on `writeRuntimeFiles` calls were
updated for its two new trailing arguments.

### Non-vacuity

Reverting the `foreign`-path guard in `ensurePluginLink` (replacing the
directory-unlink attempt with a recursive `rmSync`, so it can actually
succeed against a real directory) made "leaves an existing non-symlink
install untouched" fail: `linked` came back `true` and the real install was
replaced. Restored, it passes again.

Reverting the `try`/`catch` around the link write made "falls back rather
than dropping the plugin when linking fails" fail: instead of returning
`false`, the call threw `EACCES` out of the test. Restored, it passes again.

## Verification against the real harness

Using an isolated `DSH_HOME` under `/tmp`, `resolveVersion`/`ensureInstalled`
installed the real, published `@onetest/dsh-deck@0.2.1` under
`$DSH_HOME/runtimes`; `pluginStatus` + `ensurePluginLink` +
`writeRuntimeFiles` produced an overlay with `name: '@onetest/dsh-deck'`
(confirmed by reading the generated YAML) and a symlink at
`$DSH_HOME/profiles/web/node_modules/@onetest/dsh-deck` pointing at the
managed install's package directory. Booting the real harness
(`pnpm dsh --profile web --patch <overlay> --no-open`) from the
`deepseek-harness` checkout against that `DSH_HOME` printed `dsh web:
http://127.0.0.1:58603` with no `failed to apply loader entry` error,
confirming the loader resolved the bare package name through the symlink.
The verification process was stopped by its own captured PID; the user's
running app and `~/.dsh` were never touched, and `deepseek-harness` was left
with no working-tree changes.

## Addendum: the bare name is load-bearing, and agent presets

A follow-up investigation (`octodeck`'s
`docs/design/2026-08-24-npm-install-gaps-handoff.md`) reproduced the actual
consequence of a path-shaped overlay `name`: the harness's own
`ClientModuleRegistry` (`@deepseek-ai/dsh-client-modules`) discovers a
plugin's browser bundle by resolving the overlay's insert `name` as a
package specifier (`require.resolve(name + '/package.json')`). An absolute
path is not a valid specifier there, so a plugin inserted by path loses its
entire browser half — no error, nothing in the shell's "Failed to load
plugins" screen — while its tools (inserted the same way by the cordis
loader, which accepts either form) keep working. This is exactly the
symptom the investigation traced: `deck_create`/`deck_view` worked, no
canvas ever appeared. Every doc comment in `plugin-link.ts` and
`runtime-files.ts` that framed linking as a display-name nicety was rewritten
to state this — the bare name is the only way the browser half is found, not
a cosmetic improvement over the path form.

### A failed link no longer silently half-mounts a plugin

`plugin-entries.ts` gained `declaresClientHalf(packageDir)`, reading
`pkg.dsh?.client?.platform === 'web'` from the package's own manifest.
`ensurePluginLink` (`plugin-link.ts`) now returns a `LinkResult`
(`{ linked: true } | { linked: false; reason: string }`) instead of a bare
boolean, so a failure carries *why*. `index.ts`'s `resolveName` still falls
back to the plugin's resolved entry path on any link failure — the plugin
stays mounted, tools still work — but when the package also declares a
browser half, the failure is collected into `clientWarnings` and surfaced
two ways: appended to the tray's boot note (`"<pkg> browser UI unavailable —
not linked by name: <reason>"`) and through a new, symmetric
`clientLinkWarnings()` module-scope map (mirroring `disabledPlugins`),
threaded through `SettingsDeps`/`PluginInfo.clientWarning` to a new note on
the plugin's Settings row (`src/renderer/settings.js`/`.css`). A plugin with
no declared browser half still falls back silently — there is nothing to
report losing.

### Agent presets: `plugin-presets.ts` (new)

`@deepseek-ai/dsh-agent-presets` only discovers presets from its configured
roots plus `$DSH_HOME/.agent-presets`; a plugin cannot add its own root
(`composeProfile` replaces `roots` wholesale), so a plugin's shipped
`presets/<id>/{preset.yml,agent.cordis.yml}` is copied into
`$DSH_HOME/.agent-presets/<id>/` directly. Opt-in only: a package's own
`dsh.presets` manifest field (read by `plugin-entries.ts`'s
`presetsDeclaration`) names the directory to scan; absent, nothing is
copied, regardless of what the package's own directories happen to contain.

**Ownership tracking**: unlike a symlink, a copied directory carries no
built-in back-reference to its source. `ensurePluginPresets` writes a marker
file, `.dsh-desktop-source.json` (`{ "package": pkg }`), inside every
directory it copies; `classify` in `plugin-presets.ts` treats a directory as
this app's own only when that exact marker is present and parses. Anything
else — the user's own hand-authored preset of the same id, a directory some
other tool created — is `foreign` and is never overwritten or removed,
mirroring `plugin-link.ts`'s symlink-target-under-`runtimes` rule for links.

**Reconciliation timing**: `reconcilePluginPresets` runs in the same place
and for the same reason as `reconcilePluginLinks` — once per boot attempt in
`attemptBoot`, after every ready entry has gone through
`ensurePluginPresets` (via the same `resolveName` closure `writeRuntimeFiles`
calls), the only point at which "every preset this boot's plugins actually
provide" is known. It prunes an owned preset whose package is no longer
configured. A version change re-copies (via `rmSync` + `cpSync`) rather than
leaving the old content in place.

**Failure handling**: a copy failure is caught and skipped per-preset,
matching `plugin-link.ts`'s "never fatal" rule — a preset is a UX
enhancement, never a precondition for a plugin's tools to mount.

### Tests

`src/main/plugin-presets.spec.ts` (new, 8 tests): copies declared presets by
id; copies nothing without a declaration; never overwrites a directory the
app did not write (sentinel-file proof); re-copies on a version bump;
`reconcilePluginPresets` prunes an unconfigured plugin's preset, keeps one
still wanted, and never touches a foreign directory; a copy failure
(chmod'd read-only presets root) does not throw.

`src/main/plugin-entries.spec.ts` gained 6 tests for `declaresClientHalf`/
`presetsDeclaration` (present, absent, unreadable manifest — all
non-throwing). `src/main/plugin-link.spec.ts` was updated for
`ensurePluginLink`'s new `LinkResult` return shape. `src/main/index.spec.ts`
gained two integration tests exercising `index.ts`'s `resolveName` closure
end to end (via mocks for `./plugin-entries`, `./plugin-link`,
`./plugin-presets`): a plugin declaring a browser half that fails to link
reports it (tray note + `clientLinkWarnings()`), and one without a browser
half falls back with nothing reported.

### Non-vacuity

Removing the `declaresClientHalf` check before pushing into `clientWarnings`
(index.ts) made "reports a plugin whose declared browser half could not be
linked" fail: `clientLinkWarnings()` came back `{}` instead of naming the
package. Restored, it passes again.

Removing the ownership guard in `ensurePluginPresets` (`plugin-presets.ts`)
made "never overwrites an existing directory the app did not write" fail:
the hand-authored `preset.yml` and sentinel file were replaced by the
plugin's own copy. Restored, it passes again.

(The two `plugin-link.ts` checks from the original pass — "never clobbered"
and "link failure falls back" — were re-run against the current code as a
sanity check and reproduced the same pass/fail behavior reported above;
their guards were untouched by this addendum.)

### Verification against the real harness

Using a second isolated `DSH_HOME` under `/tmp`, `@onetest/dsh-deck@0.2.1`
was installed through this code (this time passing the plugin's own
completion marker to `ensureInstalled`, not the default `dsh`-binary one —
a mistake in the first verification script that was silently reinstalling
and wiping manifest edits until corrected). `declaresClientHalf` returned
`true` against the real published manifest (`dsh.client.platform: "web"`
is really there). `presetsDeclaration` returned `undefined` against the
real published manifest — the investigation notes `dsh.presets` has not
been added to the real package yet (field name still being agreed) — so
`dsh.presets: "./presets"` was patched into the installed copy's
`package.json` in place to exercise the preset path against real, unmodified
`presets/deck-creator/{preset.yml,agent.cordis.yml}` content already present
in the published tarball.

1. Generated `desktop.patch.yml`: `name: '@onetest/dsh-deck'`.
2. Booted the real harness (`pnpm dsh --profile web --patch ... --no-open`)
   from `deepseek-harness`: `dsh web: http://127.0.0.1:58814`, no loader
   error.
3. `curl -s http://127.0.0.1:58814/plugins/@onetest/dsh-deck/client.js | head -c 200`
   returned:
   ```
   window.__ModuleLoader__.load({
   	id: "@onetest/dsh-deck",
   	factory: (require) => {
   ```
   — confirming the client-module registry actually resolved and served the
   browser bundle, the check that proves finding A is fixed.
4. `$DSH_HOME/.agent-presets/deck-creator/` contained `preset.yml` and
   `agent.cordis.yml`, copied from the installed package.

Process stopped by its own captured PID; the user's running app, `~/.dsh`,
and `deepseek-harness` were untouched throughout (`git status --porcelain`
empty before and after).
