# Advanced tab: Open config file

## Feature

The Settings window's Advanced tab has an "Open config file…" control that
opens `desktop.json` in whatever the OS associates with it, for manual
editing. `Electron`'s `shell.openPath` does the opening, in the main process,
reached through a new `invoke`-style channel (`settings:open-config-file`) —
no new push channel, matching every other one-shot verb on this tab
(`checkBinaries`).

## Decisions

**Placement.** The Advanced tab, alongside `pnpm`/`npm path` and Check: all
three are machine-level, power-user affordances the Harness/Plugins/
Notifications tabs never need, and hand-editing JSON is squarely in that
company.

**Missing file (first run).** `loadConfig` treats a missing `desktop.json` as
ENOENT-only — the not-configured state, never seeded (see
`docs/superpowers/specs/2026-08-22-settings-window-design.md`). Seeding a
file here just to make the button work would reintroduce exactly the
seeding behavior that design deliberately removed. Instead, existence is
checked before ever calling `shell.openPath`, so first run reports "No
config file yet — save your settings once to create it." — a diagnosable
message — rather than an OS-chosen error for a path that was never real, or
a control that is disabled with no explanation. The control stays enabled
throughout; the report only depends on whether a save has happened, which
`existsSync` reflects directly without any extra state to keep in sync.

**Stale window after a hand edit.** The Settings window holds its own copy
of the form in memory; opening the file starts a second, independent editor
on the same bytes. The hint paragraph above the button says both directions
plainly: a hand edit will not appear in the form until Settings is reopened,
and Save overwrites the whole file with whatever is currently in the form.
No auto-reload on focus — the project has already shipped a bug where that
silently discarded unsaved plugin rows — and no new push channel to
half-solve it either; a full "re-read into the form" control is future work
if the plain warning turns out not to be enough.

**`openPath`'s error string.** `shell.openPath` resolves to `''` on success
and a non-empty string on failure — it never rejects. `openConfigFile`
(`src/main/open-config-file.ts`) turns that into
`{ ok: true } | { ok: false; error: string }` explicitly, and every layer
above it (`settings-ipc.ts`, the renderer) forwards the `error` string
through rather than discarding it.

## Wiring

`src/main/open-config-file.ts` is a small, dependency-injected function —
`exists`/`openPath` are parameters, not the real `node:fs`/`electron` calls —
so it is unit-tested without touching the filesystem or Electron at all.
`src/main/index.ts` wires it to `existsSync` and `shell.openPath` against the
app's real `CONFIG_PATH`. `settings-ipc.ts`'s `SettingsDeps`/
`SettingsHandlers` gain a matching `openConfigFile` entry, delegating
straight through — no save-lock, like `checkBinaries`, since this reads and
writes nothing settings-owned. `settings-window.ts` adds the
`settings:open-config-file` `ipcMain.handle`. `preload/settings.ts` exposes
`openConfigFile()` as an eighth `invoke`-backed method — no new subscription.
The renderer (`settings.js`) disables the button while the call is in
flight and shows "Opened." (green) or the real error text (red) in a
`.check-result` line, reusing the same success/failure styling `checkBinaries`
already established.

## Non-vacuity check

Reverted `open-config-file.ts`'s failure branch:

```diff
-  const error = await openPath(configPath)
-  return error === '' ? { ok: true } : { ok: false, error }
+  await openPath(configPath)
+  return { ok: true }
```

Rerunning `open-config-file.spec.ts` and `index.spec.ts`:

- **Before restoring the fix**: both `surfaces a non-empty openPath result as
  a failure rather than swallowing it` (`open-config-file.spec.ts`) and
  `surfaces an openPath failure rather than swallowing it`
  (`index.spec.ts`) failed — `{ ok: true }` instead of the expected
  `{ ok: false, error: '...' }`.
- **After restoring the fix**: both passed.

## Tests

- `src/main/open-config-file.spec.ts` — calls `openPath` with the resolved
  path; surfaces a non-empty `openPath` result as failure; reports a missing
  file without ever calling `openPath`; checks existence at the resolved
  path.
- `src/main/index.spec.ts` (`the config-file-open deps wiring`) — the same
  three behaviors through the real `index.ts` wiring, against an isolated
  `DSH_HOME` temp directory (never the real `~/.dsh`).
- `src/main/settings-ipc.spec.ts` (`openConfigFile`) — delegates to `deps`,
  writes nothing, runs freely alongside an in-flight save.
- `src/main/settings-window.spec.ts` (`the open-config-file channel`) — the
  IPC handler returns the outcome and pushes nothing.
- `src/renderer/settings.spec.ts` (`opening the config file`) — invokes the
  bridge; renders success/failure text and styling; disables the button
  while in flight; never touches Save.

## Rendering check

Served `dist/renderer/settings.html` over a local HTTP server with a stub
`window.settings`, at 640×720, light and dark. The Advanced tab shows two
cards: the existing pnpm/npm-path card, and a new "Config file" card with
the explanatory hint, the "Open config file…" button, and a result line
below it. Clicking the (stubbed) control showed "Opened." in green on
success and the real error text in red on failure, in both color schemes;
the button uses the same capsule geometry (36px height, 18px radius) and
focus-visible outline as the rest of the window. One layout bug was caught
and fixed during this check: the section caption was initially nested
inside the card itself, where its `-10px` pull-up margin (designed for a
caption sitting *above* a card) collided with the card's own `10px` grid
gap and overlapped the hint text beneath it. Moving the caption outside the
card, as a sibling before it — the same structure `source-label` and
`plugins-label` already use — fixed it.
