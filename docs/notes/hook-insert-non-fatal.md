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

## Follow-up: the walk missed peer dependencies

Review caught that the reproduced failure — `Cannot find package
'@deepseek-ai/dsh-hook-protocol'` — names a package the bridge declares only
under `peerDependencies`, not `dependencies`. The original walk checked only
`dependencies`, so it reported the bridge as loadable and inserted it
unconditionally: inert against its own repro case.

### Fix

`checkPackageLoadable` now also resolves every **non-optional**
`peerDependencies` entry (skipping any name listed in
`peerDependenciesMeta[name].optional: true`) from the package's own
directory, using the same `require.resolve` call as `dependencies`.

**Which peers must resolve, and why that is still the right bar even though
some peers are host-provided**: a required peer that cannot be found is
treated as a hard failure, even though several of the bridge's peers (e.g.
`@deepseek-ai/cordis`) are packages the harness host supplies rather than
ones the bridge's own install step places directly in its `node_modules`.
This is still correct because `require.resolve`'s search walks up every
ancestor `node_modules` starting from the package's own directory — a peer
the profile's dependency tree hoists to a shared, higher `node_modules`
(exactly how the profile installs these host-provided packages) still
resolves through that walk. A peer that fails to resolve by that walk is one
nothing in the profile provides at any level, which is exactly the break
this probe exists to catch. An *optional* peer is different in kind: its
absence is a normal, healthy install, and failing it would silently disable
notifications on every install that omits it — so it is excluded from the
required set via `peerDependenciesMeta`.

**Depth**: kept at depth-1 (the bridge's own declared dependencies/peers, not
their transitive dependencies), documented as a deliberate limit rather than
extended to a recursive walk. The reproduced failure, and the class of
failures a hook bridge can introduce on its own, are one hop from its own
`package.json`. A break two hops down is a mis-published dependency of a
dependency — outside the bridge's control, and one that would in practice
also break the harness's own boot more broadly, so it is not the primary
risk this probe targets. A full transitive walk would also make this
boot-time check scale with the whole install rather than with the one
package the overlay is deciding whether to mount.

### Tests

Added `describe('checkPackageLoadable', …)` cases against real,
constructed `node_modules` fixtures on disk (`buildFixture` in
`runtime-files.spec.ts`), not the injected stub probe used by the
`writeRuntimeFiles` tests:

- a required peer absent → not loadable, reason names the peer
- an optional peer absent → loadable
- the package plus every declared dependency and required peer present →
  loadable

**Vacuity check**: the walk was temporarily reverted to `dependencies` only
(peers dropped). Re-running the suite failed exactly the "reports the
missing peer by name…" test (`expected undefined to be defined`), with the
other 11 tests still passing — confirming that test genuinely exercises the
peer branch. The walk was then restored and the suite reconfirmed green
(12/12 in this file, 216/216 overall).

### Re-verification

`checkPackageLoadable('@deepseek-ai/dsh-hooks-claude-code', '~/.dsh/profiles/web')`
against the real, corrected walk still reports `undefined` (loadable) on
this machine — the peer `@deepseek-ai/dsh-hook-protocol` is present there
(the earlier pnpm store-linked-layout failure was already resolved
separately). `grep -rn "/Users/" src/ tests/` returned nothing.
