# A stuck apply no longer blocks saves; the Plugins tab drops its outer card

## Bug: a stuck apply permanently blocked every save

### (a) The apply could hang forever

`applySettings` (`src/main/index.ts`) restarts the harness through
`restart()` → `bootNow()` → `attemptBoot()`, and this chain is already fully
bounded: `startServer` has a 60s readiness timeout, `stopGroup` bounds a kill
to `KILL_GRACE_MS + REAP_TIMEOUT_MS` (~4s), and the isolation-retry loop caps
out at `1 + MAX_ISOLATION_ATTEMPTS` (3) attempts — worst case a few minutes,
never unbounded. Tracing every `await` in `applySettings` confirmed this: the
one genuinely unbounded wait was `notifier?.close()` in `src/main/notify.ts`.

Node's `http.Server.close()` invokes its callback only once every connection
it accepted has *ended* — including a connection that was accepted and sent
headers (e.g. a `Content-Length` body) but never finished sending it. A
stalled or dropped client leaves that connection open indefinitely, and
`close()`'s callback then never fires. Reproduced directly: a raw socket that
sends `POST /turn-end HTTP/1.1` with `Content-Length: 100` and never sends
the 100 bytes makes `server.close()` hang forever in a bare Node script, and
made `src/main/notify.spec.ts`'s new test time out under vitest.

**Fix**: `close()` now races the graceful close against a 3s bound
(`CLOSE_TIMEOUT_MS`); if it hasn't finished by then, `server.closeAllConnections()`
force-closes whatever is left, and `close()`'s own callback still fires once
that completes. The bound is the same shape `stopGroup` already uses for the
harness child (grace period, then force).

## (b)/(c): save now always writes; only the apply is serialized, latest-wins

`settings-ipc.ts`'s `performSave` no longer takes a `saving` lock around the
whole validate→install→write→apply pipeline. It now:

1. Refuses only when the app is quitting (the one still-genuinely-unsafe case).
2. Validates the form, and — for a **managed harness change only** — installs
   it synchronously (rare, and already bounded by `INSTALL_TIMEOUT_MS`; a
   dist-tag must never reach disk, and `HarnessSource.version` has no
   "unresolved" state to defer this into).
3. Writes the config to disk immediately, with plugin entries carrying
   forward their previously resolved `version` for an unchanged spec, or left
   `undefined` (an existing, already-handled state — see `pluginStatus`) for a
   new/changed one. **This is what makes a plugin-row removal or reorder
   persist instantly, with no install in its way at all.**
4. Schedules the actual plugin install + `deps.apply` (the harness restart)
   as a job on a shared, single-flight queue (`scheduleJob`/`drain`).

The queue holds at most one running job and one queued job. A new submission
supersedes whatever is queued (not yet started) rather than running behind it
— latest-wins — and the currently *running* job is never touched, so at most
one install and one harness child are ever active. `acceptPluginUpdate`
submits to the same queue, so it and `save` never install or apply
concurrently either.

A superseded call still has its write durable on disk (that already
happened before the job was ever scheduled); it just reports no install/apply
warnings of its own.

`appliedConfig` (module-scope in `createSettingsHandlers`) tracks what
`deps.apply` was last actually handed, separately from what's on disk — since
disk can now race ahead of what the running app reflects. Both `save`'s and
`acceptPluginUpdate`'s jobs diff against `appliedConfig`, not a fresh
`readConfig()`, to know what actually changed.

### Message

The only remaining refusal is `isQuitting()`, whose existing message ("The
app is shutting down; settings were not saved.") is accurate and actionable.
`SAVE_IN_PROGRESS` is gone — it no longer describes a reachable, honest state.

## Non-vacuity

**"A save arriving while an apply is in flight still writes to disk"**
(`settings-ipc.spec.ts`): reverted `performSave` to write only after the
scheduled job resolves (the pre-fix shape) — the test failed:
`expected 1 to be greater than 1` (the second save's write never landed
while the first apply was still pending). Restored, and it passes.

**"Two saves never spawn two children / never run two applies concurrently"**:
replaced `scheduleJob` with a version that runs `run()` immediately,
unserialized — the test failed: `expected 2 to be 1` (the in-mock `inFlight`
counter observed two concurrent `apply` calls). Restored, and it passes.

## UI: Plugins tab drops its outer card

Each plugin row (`.plugin-row`) is already its own card. The Plugins tab
also wrapped the whole list in an outer `<section class="group">` — the same
card-styled container every other tab uses for a single group of fields —
so it read as boxes nested inside a box.

Added a `.group-flat` modifier (`src/renderer/settings.css`), applied only to
the Plugins tab's group (`src/renderer/settings.html`): it keeps the same
`display: grid; gap: 10px` rhythm that holds the hint, the Add-a-package row,
and the row list together, but drops the border, background, and padding
that drew the outer card. The section caption (`.group-label`) already sits
above the card, not inside it, so it needed no change.

Verified by serving the built `dist/renderer/settings.html` with a stub
`window.settings` carrying four plugin rows (a floating entry, a pinned entry
with a config JSON block expanded, a disabled entry, and a plain entry) at
640×720 in both color schemes:

- **Light**: the four row cards (white fill, light border) sit directly on
  the white panel background, with clear light-gray borders separating them;
  the disabled row's red-tinted card stands out immediately. No visible outer
  box around the list.
- **Dark**: the same rows in their dark `--input-fill` tone sit directly on
  the dark panel background; the disabled row's red border/tint reads clearly
  against it. Tabbing to the Add button and to a row's Remove button showed a
  clear blue focus ring in both themes.

## Status

- Branch: `fix/save-not-blocked-by-apply`
- `npm run build`: passed.
- `npx vitest run`: 413/413 passed (410 baseline + 3 new: one in
  `notify.spec.ts`, two net new in `settings-ipc.spec.ts` after replacing
  three obsolete concurrent-save tests with five new ones).
- `npm run pack && npm run test:smoke`: **not run** — the user's packaged app
  was running (`pgrep -f "DeepSeek Harness.app/Contents/MacOS"` returned a
  PID) for the whole session, and rewriting `app.asar` under a live process
  would corrupt it.
