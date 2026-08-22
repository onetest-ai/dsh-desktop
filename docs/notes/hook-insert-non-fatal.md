# Hook bridge insert must not be able to prevent boot

## Defect

`writeRuntimeFiles` (`src/main/runtime-files.ts`) always inserted the
`@deepseek-ai/dsh-hooks-claude-code` bridge into the generated cordis patch
overlay. If the bridge could not be loaded from the profile — a broken
install, a store-linked layout a plain `npm` runtime cannot follow, or any
future unresolvable plugin — cordis refused to load the whole plugin tree,
and the harness would not boot at all. A missing notification hook should
cost notifications, not the entire application.

## Fix

Before writing the overlay, `writeRuntimeFiles` now probes whether the hook
bridge is actually loadable from the harness profile directory
(`$DSH_HOME/profiles/web`, the directory the harness resolves profile
plugins from — `--profile web` is hardcoded in `spawnFor`). If it is not,
the `insert:` block is left out of the overlay entirely; the webserver port
pin is still written either way. The omission reason is recorded as a
comment in the generated YAML and surfaced through the tray, which now
carries an optional `note` alongside `ServerStatus` — appended to the
tooltip and shown as a disabled menu row when the harness boots with
notifications degraded.

### Loadability probe

`checkPackageLoadable` (`src/main/runtime-files.ts`) uses Node's own module
resolution via `createRequire(...).resolve`. Resolving the bridge package
alone is not sufficient: `require.resolve` follows `exports`/`main` to an
entry file without executing it, so a dependency the entry file imports at
runtime — the actual failure reproduced (`Cannot find package
'@deepseek-ai/dsh-hook-protocol'` from inside the bridge's own `lib/index.js`)
— never surfaces from resolving the bridge alone. The probe therefore also
resolves every dependency the bridge's own `package.json` declares, from the
bridge's own directory, all without ever executing the bridge's code. The
whole function is wrapped so it can never throw; callers get a reason string
or `undefined`.

The probe is injected into `writeRuntimeFiles` (default:
`checkPackageLoadable`), so tests exercise the omit/insert branching without
depending on what happens to be installed on the developer's machine.

### Surfacing channel

The tray was chosen over `applySettings`'s `warnings: string[]`: that channel
only exists inside a `save()` round trip, but the hook bridge's loadability
is discovered at every boot (`bootNow`), not only when settings are saved.
The tray already tracks `ServerStatus` per boot, so it was extended rather
than inventing a new mechanism.

## Tests (`src/main/runtime-files.spec.ts`)

- `writeRuntimeFiles` includes the insert when the injected probe reports
  loadable.
- `writeRuntimeFiles` omits the insert and reports the reason when the probe
  reports unloadable.
- The webserver port pin (`port: 0`) is present in both cases.
- `checkPackageLoadable` never throws, including from a nonexistent
  directory.

**Vacuity check**: the probe call site in `writeRuntimeFiles` was temporarily
forced to always report loadable (`const hooksOmittedReason = undefined`).
Re-running the suite failed exactly the "omits the insert…" test
(`expected undefined to be 'package not found'`), with everything else still
passing — confirming that test genuinely depends on the probe result. The
change was then reverted and the suite reconfirmed green (45/45 in the two
files, 213/213 overall).

## Real verification

Both checks called the actual built `dist/main/runtime-files.js` and then
booted the real harness (`pnpm dsh --profile web --patch <overlay>
--no-open`) from the local checkout configured in `~/.dsh/desktop.json`,
watching for the `dsh web: http://127.0.0.1:<port>` ready line.

1. **Happy path**: `profileDirectory` pointed at the real
   `~/.dsh/profiles/web` (bridge genuinely installed there). Generated
   overlay contained the `insert:` block. `pnpm dsh --profile web --patch
   <path> --no-open` printed `dsh web: http://127.0.0.1:62967` — the harness
   booted normally with notifications wired up.
2. **Omit path**: `profileDirectory` pointed at a freshly created empty temp
   directory (bridge genuinely not installed there), without touching
   `~/.dsh/profiles`. Generated overlay omitted `insert:` and recorded the
   resolution failure as a comment. `pnpm dsh --profile web --patch <path>
   --no-open` printed `dsh web: http://127.0.0.1:62974` — the harness booted
   normally, with only notifications degraded.

`deepseek-harness`'s `git status --porcelain` was empty before, during, and
after both boots. `~/.dsh/desktop.json`'s md5
(`aab7d246b3afc2671317f09bffd86158`) was unchanged throughout. The harness's
own boot process idempotently rewrote `~/.dsh/profiles/web/cordis.yml` to
its same static contents (`[]` plus its header comment) — normal `dsh
--profile web` bootstrap behavior on every boot, not something this change
introduced or that alters `profiles/`'s meaning.

`npm run pack && npm run test:smoke` also passed against the packaged app
(real `~/.dsh`, bridge loadable), confirming the shipped build still boots
and leaves no orphaned processes.
