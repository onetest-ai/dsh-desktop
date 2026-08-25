# dsh-desktop — design

Date: 2026-08-21
Status: approved, not yet implemented

## Purpose

Run the DeepSeek Harness Web UI as a real macOS desktop application — installable, with tray, notifications, a global hotkey, and a `dsh://` handler — without adding a single file to the harness checkout at `~/Development/deepseek-harness`.

## Non-goals

- Distributing this to anyone else. It is a personal shell over a local checkout.
- Changing the harness UI, its packages, or its build. Any requirement that forces a harness edit is out of scope and gets raised rather than absorbed.
- Bundling a harness runtime. The app always runs the live checkout.

## The zero-touch constraint

The driving requirement is that `git pull origin` in the harness repo stays exactly as it is today. Three things would break that, and the design avoids all three:

1. **`.gitignore` is tracked.** Adding ignore rules there creates upstream conflicts. This project adds no rules at all; there is nothing in the checkout to ignore.
2. **`pnpm-workspace.yaml` globs `apps/*`.** A desktop app at `apps/desktop/` would be adopted as a workspace member, and `pnpm install` would rewrite the tracked `pnpm-lock.yaml`. Living outside the checkout makes this impossible rather than merely unlikely.
3. **Doc and hygiene gates run over the tree.** A new file under `docs/` would trip `verify-doc-budgets` and translation pairing. This spec therefore lives here, in the sidecar.

Everything the app needs to configure about the harness goes through documented, out-of-repo extension points: a `--patch` overlay file owned by this project, and the profile directory under `$DSH_HOME` (`~/.dsh`).

## Layout

```
~/Development/dsh-desktop/
  package.json            electron + electron-builder, own lockfile
  src/main/               Electron main process
    runtime-files.ts      generates the cordis overlay and the hooks file per boot
    server.ts             spawn, ready-line parse, teardown
    window.ts             BrowserWindow + application menu
    tray.ts               tray icon, status, menu
    notify.ts             localhost listener for the Stop hook
    protocol.ts           dsh:// registration and focus handling
  src/main/*.spec.ts      Vitest, no Electron required
  tests/smoke.spec.ts     Playwright over the packaged app
  docs/                   this file
```

## Architecture

One Electron main process owns one child server process and one window.

### Server lifecycle

Spawn, with `cwd` set to `harnessRepo`:

```
pnpm dsh --profile web --patch <userData>/runtime/desktop.patch.yml --no-open
```

Flag order is load-bearing: `dsh web` is an alias for `--profile web`, and the launcher's own flags must precede it — the first token the launcher does not recognize begins the *inner* arguments handed to the web app. `dsh web --patch <file>` fails with `unknown option '--patch'`.

The overlay sets `webServer.port: 0`. The webserver schema treats port `0` as "OS-assigned" (`packages/host/webserver/src/index.ts`), so the app never collides with a `pnpm dsh web` run by hand in a terminal.

**Readiness and port discovery are the same signal.** `packages/bundle/web-app/src/index.ts` prints `dsh web: http://127.0.0.1:<port>` on stdout exactly once the server is listening. The main process reads stdout line by line, matches that prefix, extracts the URL, and loads it. No polling, no port guessing, no fixed sleep.

If the ready line does not arrive within 60s, the window shows a failure pane with captured stderr rather than hanging on a blank screen.

**Preflight**, before spawning:

- `harnessRepo` exists and is a directory.
- `harnessRepo/apps/web/dist` exists. A fresh pull with no build yields a server that serves nothing; the correct response is a message naming `pnpm run build:web`, not a blank window.

**Teardown is the part naive wrappers get wrong.** The harness spawns `node-pty` children, so killing only the direct child orphans terminal processes. The child is spawned `detached: true` and killed as a process group (`process.kill(-pid, ...)`), SIGTERM first, SIGKILL after a grace period. `app.requestSingleInstanceLock()` prevents a second instance racing a second server. Read `docs/defensive-patterns.md` in the harness before implementing this.

Server exit while the app is running turns the tray indicator red and swaps the window for a retry pane showing the captured stderr. Only the *current* child may do so: every child carries the generation that spawned it, and a superseded child's exit is ignored, because a child that outlives its SIGTERM can report its exit after a replacement is already serving the window.

**Every async lifecycle transition is one link in a serialized chain** (`enqueue` in `src/main/index.ts`), and `before-quit` makes itself the last link. A quit therefore cannot slip through the gap inside a restart — the window between stopping the old child and spawning the new one — and leave a freshly spawned detached harness behind.

**Closing the window does not quit the app**; it hides it, leaving the tray in charge. Quit goes through the tray's Quit item or Cmd+Q, both of which reach `before-quit` and its reaping path.

### Window

`BrowserWindow` with `contextIsolation: true` and `nodeIntegration: false`, loading the discovered URL. No preload is needed for v1 — the UI is used unmodified. A standard application menu is required so that copy/paste, reload, and devtools keyboard shortcuts work; Electron does not provide usable defaults for a custom app.

### OS integration

**Tray** — status dot (running / starting / failed), show-or-hide window, restart server, quit.

**Global hotkey** — `globalShortcut` toggles window visibility. Configurable in `config.json`.

**Notifications** — the harness runs Claude Code-dialect command hooks through `@deepseek-ai/dsh-hooks-claude-code`, which maps `Stop` onto the `agent/turn-stopping` interception point. A `Stop` hook in the generated `hooks.json` POSTs to a localhost port owned by the app; the app raises a native `Notification` when its window is not focused.

The listener binds `127.0.0.1` on a **fixed** port from `desktop.json` (`notifyPort`, default `43117`), not an OS-assigned one: the harness reads its hook config once at load, so the hook command cannot discover a port chosen after the fact. If the port is already bound, the app starts without notifications and says so in the tray rather than failing to launch.

The hook MUST be non-blocking: it exits 0 and emits no decision JSON. A blocking `Stop` hook feeds its reason through `steer()` and forces another agent step, which would turn a notification into an infinite loop.

Installing the bridge into the web profile is an out-of-repo operation:

```
pnpm dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code
```

This writes into the profile directory under `~/.dsh`, not the checkout. The generated overlay then points the bridge at the generated `hooks.json` via `configPath`.

**Both files are generated at boot** into `app.getPath('userData')/runtime`, never shipped in the bundle. Each carries values that are only known at runtime: absolute paths on the machine the app is installed on, and the configured `notifyPort`. A checked-in copy would pin one developer's paths and one hardcoded port, and the bridge answers an unreadable `configPath` by warning and registering no hooks at all — so notifications would die silently. `userData` is also writable by construction, which a packaged app's own resources are not.

**Deep links** — `app.setAsDefaultProtocolClient('dsh')` plus the bundle-id registration electron-builder emits. A `dsh://` URL launches or focuses the app.

**Known limitation, accepted for v1:** the web client has no URL routing — no router dependency and no `window.location` state anywhere in `packages/client` — so there is no address for an individual session. `dsh://` can therefore only open and focus the app; it cannot navigate to a specific session. Per-session deep links would require adding routing to the tracked harness repo, which contradicts the zero-touch constraint and is deliberately deferred to a separate decision.

## Error handling

| Condition | Behavior |
|---|---|
| `harnessRepo` missing or not a directory | Startup pane naming the configured path; no spawn attempt |
| `apps/web/dist` missing | Startup pane naming `pnpm run build:web` |
| No ready line within 60s | Failure pane with captured stderr; retry button |
| Server exits unexpectedly | Tray red, retry pane with exit code and stderr tail |
| Second instance launched | Focus the existing window and exit |
| Port already taken | Cannot occur; port 0 is OS-assigned |

## Testing

Main-process logic holds the risk, and none of it needs Electron to test.

**Vitest, against a fake server script that prints a controlled ready line:**

- Parses the ready line and extracts the correct URL.
- Ignores unrelated stdout before the ready line.
- Times out cleanly when the ready line never arrives.
- Both preflight failures produce their specific messages and never spawn.
- Unexpected child exit surfaces the exit code and stderr tail.
- Teardown kills the whole process group: a fake server that forks a grandchild leaves no survivor.

**Playwright, over the packaged app, one smoke:** launch, window renders the harness UI, quit, assert no surviving child processes.

## Sequencing

1. Project scaffold, config loading, preflight.
2. Server spawn, ready-line parse, window. (First point it is usable.)
3. Teardown and single-instance correctness, with the process-group tests.
4. Tray and global hotkey.
5. Notification listener plus hooks.json wiring.
6. `dsh://` registration, focus-only.
7. electron-builder packaging and icon.

Estimate: 3–4 days.

## Open questions

None blocking. Per-session deep links are deferred pending a separate decision about upstreaming client routing.
