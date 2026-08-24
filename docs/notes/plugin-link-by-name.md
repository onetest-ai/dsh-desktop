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
