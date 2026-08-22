# Settings window and first-run onboarding — design

Date: 2026-08-22
Status: approved, not yet implemented
Supersedes: the first-run seeding behavior described in [the original design](../../2026-08-21-dsh-desktop-design.md)

## Purpose

Remove the last machine-specific hardcode from `dsh-desktop`, and give the app a Settings window — opened from the menu bar, and automatically on first run — so its configuration is chosen by the user rather than baked into the source.

Today `src/main/index.ts` hardcodes `CANDIDATE_REPO = '/Users/arozumenko/Development/deepseek-harness'` as the first-run default. On any other machine that path does not exist, so first run silently seeds a config pointing at nothing, falls through to npx mode, and fails to start. The app is not usable by anyone but its author.

## Non-goals

- Exposing every tunable as configuration. Only machine-specific values move; ordinary defaults (`notifyPort` 43117, the hotkey, the npx package name, timeouts) stay in code and remain overridable through the config file, as they are now.
- Editing harness settings. This window configures the desktop shell only; `~/.dsh/settings.yaml` belongs to the harness and is never read or written here.
- A settings UI for anything not already in `DesktopConfig`.

## Scope of the hardcode removal

`CANDIDATE_REPO` is deleted. Two functions change with it:

- `loadConfig(filePath, candidateRepo)` loses its second parameter. When the file is absent (ENOENT) it no longer seeds a default — it returns a distinct **not-configured** result. Non-ENOENT read failures still throw loudly, unchanged.
- `defaultSource(candidateRepo)` is deleted outright. With no machine to guess about, guessing is the wrong behavior; the user is asked instead.

Everything else that could be called a default — port, hotkey, package name, version — is an ordinary in-code default that config overrides. Those are not machine-specific and stay.

## Architecture

### Window separation is a security boundary, not a preference

The Settings window is a second `BrowserWindow` with its own preload. The main window keeps `contextIsolation: true`, `nodeIntegration: false`, and **no preload**.

This matters: the main window loads the harness Web UI. Attaching a preload there to serve settings would expose an IPC bridge to that page. Keeping settings in its own window means the harness UI can never reach `fs`, the config, or the folder picker, whatever it renders.

### New files

```
src/main/settings-window.ts    window lifecycle: create, focus-if-open, close
src/main/settings-ipc.ts       the three handlers, as plain testable functions
src/preload/settings.ts        contextBridge: exactly three methods
src/renderer/settings.html     the form
src/renderer/settings.css
src/renderer/settings.js       form wiring only; no logic worth testing
```

### The IPC contract

Three `invoke`/`handle` channels. Every one validates in main.

| Channel | Argument | Returns |
|---|---|---|
| `settings:read` | none | `{ configured: true, config } \| { configured: false }` |
| `settings:pick-folder` | none | absolute path, or `undefined` if cancelled |
| `settings:save` | form values | `{ ok: true } \| { ok: false, errors: FieldErrors }` |

The renderer never touches `fs`, never constructs a path it did not receive from main, and cannot write anything. All validation lives in main.

## First run

`whenReady` reads the config:

- **Not configured** → open the Settings window; do not boot a harness. The main window is not shown until a valid config is saved.
- **Configured** → boot exactly as today.

A save that completes a first-run configuration boots the harness and shows the main window.

**Closing first-run Settings without saving quits the app.** There is nothing else for it to do: no config means no harness to boot and no main window to show, and leaving a trayed process with no reachable window would strand the user. Closing Settings when a valid config already exists just closes the window, leaving the app running as normal.

## Reaching it later

`File → Settings…` (⌘,), and the same item in the tray menu. On macOS ⌘, conventionally lives in the app menu; it is added to both, because the File menu was explicitly requested.

Opening Settings when the window already exists focuses it rather than creating a second one.

## Applying a save

Saving writes `desktop.json` first, then applies. Each field routes to the narrowest re-application that covers it:

- **Harness source changed** (`kind`, `repo`, `package`, `version`, `workspace`) → `enqueue` a stop-then-boot, reusing the same serialized transition the tray's Restart uses. That chain already handles the quit-during-restart race and the stale-`onExit` generation check, and it is already tested. `writeRuntimeFiles` runs as part of that boot, so a changed `notifyPort` reaches the generated `hooks.json` with no extra work.
- **`notifyPort` changed** → also a stop-then-boot, *and* the notify listener is closed and reopened on the new port. The restart is not optional: `writeRuntimeFiles` bakes the port into the generated `hooks.json` at boot, so skipping it would leave the hook posting to the old port and notifications would fail silently.
- **`pnpmPath` / `npxPath` changed** → stop-then-boot, since both are resolved when the child is spawned.
- **`hotkey` changed** → `globalShortcut.unregisterAll()`, then re-register, reporting a failed registration the same way the existing unchecked-register fix does.

A save arriving during an in-flight boot is safe: it goes through `enqueue`. A save arriving during quit is refused, because `quitting` is already set.

## Error handling

| Condition | Behavior |
|---|---|
| Repo path empty, or not a directory | Inline field error; nothing written |
| npx package empty | Inline field error; nothing written |
| Port outside 1–65535 | Inline field error; nothing written |
| Port already bound | Inline field error naming the port; nothing written |
| Hotkey rejected by the OS | Config saves; the Settings window shows a non-blocking warning naming the accelerator, and the tray menu label reports the hotkey as unbound |
| Config valid but harness fails to boot | Config stays written; the existing failure pane shows, Settings still reachable |
| Non-ENOENT read failure on `desktop.json` | Throws loudly, as today — never silently replaced |

Validation runs before the write, so a rejected save never leaves a partial config on disk.

## Testing

Main-process logic is unit-tested with `vi.mock('electron')`, extending the 12 orchestration tests already present:

- `loadConfig` returns not-configured on ENOENT and still throws on other read errors.
- Each validation rule rejects its bad input and accepts its good one.
- `settings:save` routes correctly: a source change enqueues a restart; a port-only change enqueues a restart *and* rebinds the listener; a hotkey-only change re-registers without restarting.
- A save during quit is refused.
- The first-run branch opens Settings and does not boot.

The three IPC handlers are tested as plain functions, separate from channel registration. The renderer form gets no unit tests — it holds no logic, which is the point of keeping it dumb.

## Build changes

The project gains a renderer for the first time. `tsconfig` must emit `src/preload` alongside `src/main`, the renderer assets must be copied into `dist`, and `electron-builder`'s `files` list must include both. A packaged build that omits the preload fails at window creation, so packaging is verified by launching the packaged app and opening Settings — not by the build succeeding.

## Open questions

None.
