# Per-plugin config, and a plugin-caused boot failure is recoverable

## 1. Per-plugin configuration

`PluginEntry` gains an optional `config?: Record<string, unknown>` — a
free-form JSON object, since only the plugin itself knows its own schema.
`config.ts`'s `parseConfig` validates a hand-edited `desktop.json`'s entry
config is a JSON object (not an array, string, or null), the same
defense-in-depth as the existing spec-shape check. `runtime-files.ts`'s
`patchOverlay` emits a set config as a flow-style YAML mapping —
`config: {"base":"/x"}` — which is valid YAML for any JSON value, so no
hand-rolled YAML serializer was needed; an entry with no config keeps the
existing `config: {}`. The hook bridge's privileged `configPath` override
(unaffected by this change) still wins when both are present, though nothing
sets both today.

**Settings UI**: each plugin row grows a collapsible config editor —
`<details>` + a monospace JSON textarea, collapsed by default, open (and
relabelled "Config (set)") when a config is already stored, so a row with
nothing configured stays exactly as compact as before this field existed. A
new `validatePluginConfig` IPC call gives the textarea the same live,
on-blur validation the spec input already had (`settings:validate-plugin`),
over the same `parsePluginConfig` grammar `save` re-checks in
`parsePluginsField`. A parse failure surfaces beside that row's own textarea,
never on the field-wide `error-plugins` node; `save`'s own defense-in-depth
check (for a row that skipped the blur validation) still names the offending
package in its message.

The wire format for `SettingsForm.plugins` changed from a newline-joined spec
string to `{ spec: string; config: string }[]` — the row-based Add control
already built that string from an array of rows, so this only changes what
crosses the `save` IPC call, not the renderer's own data model.

## 2. A plugin-caused boot failure is recoverable

`bootNow` is split into `attemptBoot(config, generationToken, includePlugins)`,
called up to twice. The primary attempt includes every configured plugin, as
before. On a **server-stage** failure (the harness process itself failed to
start — not a `ConfigurationError`, which means a bad harness path or
launcher, unrelated to plugins) where the overlay had actually inserted at
least one plugin (`insertedCount > 0`, computed from the probed `ready`/
`omitted` split, not merely "plugins were configured"), `bootNow` retries once
with `includePlugins: false` — every plugin insert removed, the overlay
reduced to just the `webserver` pin.

- Retry success: tray status stays `running`, with a note —
  `plugins disabled — the harness would not start with them: <original error>`
  — using the *tray's existing note mechanism* (`setStatus(status, note)`),
  not a new `ServerStatus` value. No UI changes needed there.
- Retry failure: the *original* attempt's error is what gets reported (not
  the retry's), matching "the plugins were not the cause, the existing error
  pane stands."
- No plugins inserted (`insertedCount === 0`): no retry at all, so an
  ordinary failure — a bad harness path, for instance — still fails once, not
  after a second full `READY_TIMEOUT_MS`.

**Serialization and leak-safety**: the retry runs inside the same `bootNow`
call, itself already inside the one serialized `enqueue` chain — no second
child is ever spawned concurrently. `stopCurrent()` always advances the
module-level `generation` counter, including the app's own expected reap
after the primary failure; the retry therefore captures a fresh
`afterOwnReap` token right after that reap (not the boot's original `mine`)
to tell its own legitimate advance from an illegitimate one (a `shutdown()`
racing in and reaping the retry's child from under it). If a quit lands while
the retry's child is still starting, `shutdown()`'s own direct `stopCurrent()`
call reaps it before `bootNow` gets to; `bootNow` detects the generation has
moved past its own token and skips its own redundant stop, so the child is
stopped exactly once, never left running.

### Non-vacuity

- Hardwired `canRetryWithoutPlugins` to `false`: `plugin-caused boot failures
  > retries once with plugins removed…` failed — the second `startServer`
  call (the retry) never happened, so the test's `children[1]` never
  materialized (`expected 1 to be 2`). Restored; suite green again.
- Removed the `attempt.insertedCount > 0` guard: `plugin-caused boot failures
  > does not retry, and does not double the wait…` failed — `startServer` was
  called twice instead of once, because a boot with no plugins configured
  now retried anyway. Restored; suite green again.

## Real-world verification

Isolated `DSH_HOME` under a temp directory, `@onetest/dsh-deck@0.2.1`
installed via `npm install --prefix` into the exact `managedDir` layout the
app uses, entry file resolved through the shipped `resolvePluginEntry`.

**State 1 (reproducing the user's report)**: real local harness checkout
(`pnpm dsh --profile web --patch <overlay>`) booted against an overlay built
by the shipped `patchOverlay` with the entry's `config` left unset —
reproduced the user's exact error verbatim: `invalid config: - base must be a
non-empty string starting with "/", received undefined (at base)`.

**State 2 (fix 1 — config reaches the plugin)**: same overlay, entry now
carrying `config: { base: '/deck' }` (what the Settings UI would now
produce) — harness reported ready in seconds; `GET
/deck/somefakedeck/` returned the plugin's own compiled response text,
proving the plugin's code executed inside the running process, not merely
that boot survived.

**State 3 (fix 2 — retry recovers)**: the *packaged* app (`npm run pack`),
launched via Playwright's `_electron`, `desktop.json` pointed at the same
`@onetest/dsh-deck` entry with config left empty — the window loaded a real
harness URL (no error pane), and `GET /deck/somefakedeck/` returned an empty
404 (the harness's own default, not the plugin's route) — confirming the app
booted *without* the plugin via the retry path, exactly as designed. A
control run with `config: { base: '/deck' }` against the same packaged app
booted with the plugin's own response text, confirming the two states are
genuinely distinguishable through the real app, not just in unit tests.

All ad hoc processes and Electron instances spawned during verification were
stopped by their own captured PIDs; `pgrep` confirmed no descendants of this
session's spawns survived. `~/.dsh` and the user's running app were never
touched — every run used a fresh `mkdtemp` `$DSH_HOME` and `--user-data-dir`.
