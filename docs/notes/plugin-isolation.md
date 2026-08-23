# Isolating a plugin-caused boot failure, and surfacing it in Settings

## The situation

`dsh-mcp-client` and `@onetest/dsh-deck` (configured with `{ "base": ".deck" }`,
which `dsh-deck` requires to start with `/`) were both configured. `dsh-deck`
rejected its config at boot; the existing drop-all retry (from the prior
`plugin-config.md` fix) recovered by dropping *every* plugin, including the
healthy `dsh-mcp-client`. The only report was a tray tooltip the user never
opened, so they read "neither plugin is searchable" as a load failure rather
than a config mistake that had already been silently worked around.

## Fix 1 — isolate the one plugin the failure names, not every plugin

`attemptBoot` no longer takes an `includePlugins: boolean`. It takes
`excludePackages: ReadonlySet<string>` instead: which package names to leave
out of the overlay entirely, empty for the primary boot. `writeRuntimeFiles`
now also returns `ready: { package; entryPath }[]` — every entry actually
mounted, package name paired with its resolved absolute entry file.

**Attribution** (`runtime-files.ts`'s `attributeBootFailure`): the harness's
own error names the failing insert two ways — a sanitized id (`insertId`,
e.g. `onetest-dsh-deck`) and, in parentheses, the absolute entry path
(`failed to apply loader entry onetest-dsh-deck (/…/lib/index.js): invalid
config: …`). Attribution matches on the **entry path**, not the id:
`insertId` collapses every non-alphanumeric character to `-`, so two distinct
scoped package names can sanitize to the same id (`@a-b/c` and `@a/b-c` both
become `a-b-c`), while each entry's resolved path is unique by construction —
it lives under its own package-and-version `managedDir`. Exactly one path
match is required; zero or more than one is treated as unattributable, since
guessing among several candidates risks dropping a healthy plugin while
leaving the real cause running.

**No identifiable plugin**: every remaining ready entry is dropped at once
(the old drop-all behavior), and it is still reported — through the same
`isolated` list Settings and the tray note consume, so an unattributed
failure is visibly different from "successfully identified and isolated
`dsh-deck`" only in how many packages the reason covers, never in whether it
gets reported at all.

**Retry bound**: `MAX_ISOLATION_ATTEMPTS = 2`, so `bootNow` makes at most
3 total `attemptBoot` calls (1 primary + 2 retries) regardless of how many
plugins are configured. Without a bound, a config with several independently
broken plugins could isolate one per attempt forever, each attempt paying a
full `READY_TIMEOUT_MS` (60s). Two extra attempts covers the realistic cases
this exists for — one bad plugin, or two whose failures surface one after
the other — while the unattributable fallback (drop every remaining plugin
at once) always reaches a plugin-free, guaranteed-bootable attempt within
that bound. When the bound is exhausted, `bootNow` reports the *last*
attempt's own failure (not the original) — by that point, any plugin the
loop did manage to isolate is no longer the live problem, so the most
actionable message is whatever the final, still-failing attempt reports.

## Fix 2 — a disabled plugin's reason reaches Settings, from any window

`disabledPlugins: Map<string, string>` lives at `index.ts` module scope, not
on any window. `recordDisabledPlugins` replaces it wholesale (never merges)
at the end of every boot outcome — a fresh success clears it, a boot with
pre-flight omissions or isolated entries populates it from those. A new
`SettingsDeps.disabledPlugins(): Record<string, string>` closure reads this
same module state; `settings-ipc.ts`'s `read()` merges it into each
`PluginInfo.disabledReason`. Because the state lives in the main process
rather than on a window instance, a Settings window opened long after the
boot that recorded it still shows the accurate reason — proven directly in
`index.spec.ts` by capturing the `deps` object handed to
`createSettingsHandlers` and calling `disabledPlugins()` well after the
simulated boot, independent of any window.

**UI**: `settings.js`'s `renderPluginRows` adds a `.plugin-row-disabled`
class and a `.plugin-disabled-note` paragraph (`Disabled — the harness would
not start with it: <reason>`) to a row whose `disabledReason` is set. The
tray tooltip note stays, listing every isolated/omitted package alongside
its own reason.

**Styling** (`settings.css`): `.plugin-row-disabled` gets a `var(--danger)`
border and an 8% tint of the same color over the row's normal fill —
`color-mix(in srgb, var(--danger) 8%, var(--input-fill))` — so a light or
dark theme both read it as a problem row at a glance, not decoration.
`.plugin-disabled-note` reuses `.error`'s color token and type scale so it
reads as part of the same error-reporting system as every other field on the
page.

## Non-vacuity

- Hardwired `attributeBootFailure` to always return `undefined`: "attributes
  a failure naming one plugin and retries with only that plugin dropped…"
  failed — the last `writeRuntimeFiles` call carried no survivor, because the
  unattributable fallback dropped every configured plugin instead of
  isolating just the one the error named. Restored; suite green again.
- Hardwired `recordDisabledPlugins` to a no-op: both "still boots, with the
  insert omitted…" and "attributes a failure naming one plugin…" failed —
  `disabledPlugins()` (the same closure a Settings window opened after boot
  would call) reported `{}` instead of the recorded reason. Restored; suite
  green again.

## Real-world verification

Isolated `$DSH_HOME` under a temp directory; `@onetest/dsh-deck@0.2.1` and
`@deepseek-ai/dsh-hooks-claude-code@0.0.1-rc.5` installed via
`npm install --prefix` into the exact `managedDir` layout the app uses,
entries resolved through the shipped `pluginStatus`/`resolvePluginEntry`. A
Node script required the real compiled `dist/main/*.js` modules directly
(`pluginStatus`, `writeRuntimeFiles`, `attributeBootFailure`, `startServer`,
`dshWebCommand`) and drove the same isolation loop `bootNow` runs, against
the real local `deepseek-harness` checkout.

**`{ "base": ".deck" }`** (the user's exact case, plus the healthy hooks
bridge): the primary boot failed with the harness's own verbatim error —
`failed to apply loader entry onetest-dsh-deck (…/lib/index.js): invalid
config: - base must be a non-empty string starting with "/", received
".deck" (at base)`. Attribution matched exactly `@onetest/dsh-deck`; the
retry, excluding only that package, **succeeded** with the hooks bridge
still mounted. `GET /deck/somefakedeck/` on the running harness returned a
bare `404` with an **empty body** — the harness's own default, proving
`dsh-deck` was never mounted, not merely erroring.

**`{ "base": "/deck" }`**: the primary boot **succeeded** with both plugins.
`GET /deck/somefakedeck/` returned `404` again, but this time with the
plugin's own compiled response body (`"somefakedeck" looks like a deck name,
but a deck is addressed by its key. Use the route \`deck_view\` returns for
this deck.`) — proving `dsh-deck`'s own code executed inside the running
process this time, confirming the two states are genuinely distinguishable
through the real harness, not just in unit tests.

All processes spawned during verification were stopped via their own
`handle.stop()` (mirroring the app's own reap path); `pgrep` confirmed no
descendants of this session's spawns survived. `~/.dsh` and the user's
running app (`release/mac-arm64/DeepSeek Harness.app`, PID captured and
re-checked alive and unaffected before and after `npm run pack`) were never
touched — every run used a fresh `mkdtemp` `$DSH_HOME`.
