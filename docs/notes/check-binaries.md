# Advanced tab: Check pnpm/npm paths

## Feature

The Settings window's Advanced tab has a Check button beside the `pnpm
path`/`npm path` fields. It spawns `pnpm --version` and `npm --version`
against the values currently typed in the form — never the saved config —
and reports each binary's real outcome inline, next to the field it
describes: success with the printed version, or the real failure text.

## Same environment as the real spawn

The check reuses `resolveBinary` and `envWithLauncherDir` from
`src/main/server.ts` unmodified (`src/main/check-binaries.ts`). A configured
absolute path is typically a `#!/usr/bin/env node` shebang script; the real
launch (`dshWebCommand`) prepends that binary's own directory to the
spawned child's `PATH` so the shebang's own `node` lookup succeeds even
under a Finder-inherited minimal `PATH`. The check spawns through the same
two functions, so a passing check can only mean the real launch would pass
too. A blank field resolves via `resolveBinary(undefined, name, env)`,
exactly like the app's own boot path — never skipped.

## Non-vacuity check

`src/main/check-binaries.spec.ts`'s `checkBinary against a real shebang
launcher` test spawns a real Node process against a generated shebang script
whose interpreter (`node`) sits only in the script's own directory, with the
child environment's `PATH` restricted to `/usr/bin:/bin`. This only succeeds
through `envWithLauncherDir`'s prepend.

Verified by reverting `checkBinary`'s `const childEnv = envWithLauncherDir(command, env) ?? env`
to `const childEnv = env` and rerunning that one test:

- **Before the fix (bare `env`)**: the test failed —
  `{ ok: false, error: 'env: node: No such file or directory' }` instead of
  `{ ok: true, version: '9.1.0' }`.
- **After restoring the fix**: the test passed.

## Wiring

A sixth `invoke`-style preload/IPC call, `checkBinaries`, mirrors the shape
of the existing `validatePlugin` call: `settings:check-binaries` in
`settings-window.ts`, forwarded through `SettingsHandlers.checkBinaries` /
`SettingsDeps.checkBinaries` in `settings-ipc.ts`, backed in `index.ts` by
`checkBinaries(pnpmPath, npmPath, process.env, CHECK_BINARY_TIMEOUT_MS)`. No
new push channel; the renderer only renders what the one `invoke` call
returns. The check reads no config and calls neither `writeConfig` nor
`apply` — it runs freely alongside a save already in flight rather than
sharing its lock.

## Bound

`CHECK_BINARY_TIMEOUT_MS = 10_000` in `index.ts`, matching the existing
precedent of hardcoded internal safety bounds (`READY_TIMEOUT_MS`,
`KILL_GRACE_MS`, `REAP_TIMEOUT_MS` in `server.ts`) rather than a new Config
field — this is an internal hang guard, not a deployment-varying choice. On
timeout the child is SIGKILLed and the button re-enables.

## Styling

`src/renderer/settings.css` gains `.check-result`/`.check-result-ok`/
`.check-result-failed`, reusing the existing `--ok`/`--danger` tokens the
Save status line already uses, so both themes stay consistent with the rest
of the window. Each result sits directly under the field it describes.
Verified by serving `dist/renderer/settings.html` (via a preview harness
stubbing `window.settings`) over a local HTTP server at 640x720 in both
color schemes — see the session's own report for what was observed.

## Tests

`src/main/check-binaries.spec.ts` (10 tests): success with printed version,
real stderr surfaced on non-zero exit (not a generic message), a spawn
error surfaced verbatim, `resolveBinary`'s own refusal surfaced when PATH is
system-only, a blank field resolving through PATH, the PATH extension
matching `dshWebCommand`'s own, the timeout killing the child, both binaries
checked independently (one success, one real failure), a blank field on
both, and the real-shebang non-vacuity test above.

`src/main/settings-ipc.spec.ts`: the handler forwards the two form values
verbatim and writes nothing; it runs freely alongside a save already in
flight.

`src/main/settings-window.spec.ts`: the IPC channel forwards its arguments
and returns the answer without pushing anything.

`src/renderer/settings.spec.ts`: both binaries succeed and report versions;
one fails with its real error while the other still succeeds; a blank field
is checked via PATH rather than skipped; the button disables during the
check and re-enables after; Save is never called by Check.
