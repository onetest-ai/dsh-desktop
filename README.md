# DeepSeek Harness Desktop

A macOS desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI. It runs the harness as a child process, discovers the port it binds, and loads it in a native window — with a menu-bar tray, a global show/hide shortcut, turn-completion notifications, and a `dsh://` handler.

It is a **shell, not a fork**: it never modifies the harness. Point it at a checkout and `git pull` there stays clean.

## Requirements

- macOS (Apple Silicon; the packaging target is `mac-arm64`)
- Node 22 or newer
- One of:
  - **a local harness checkout** with its frontend built (`pnpm run build:web`), plus `pnpm` on your `PATH`, or
  - **a managed install**, to run the published `@deepseek-ai/dsh` package instead — Settings installs it under `$DSH_HOME` on save, no checkout required

## Running it

### From source

```bash
npm install
npm start
```

`npm start` compiles and launches. The window stays open until you quit — closing it hides the app to the tray.

### As a packaged app

```bash
npm run pack
```

This writes `release/mac-arm64/DeepSeek Harness.app`. Drag it to `/Applications` and launch it like any other app.

Use `npm run dist` instead if you want a distributable installer rather than a plain `.app` directory.

The build is **unsigned** (`identity: null`). On first launch macOS may refuse to open it; right-click the app and choose *Open* to get the one-time override. It is not notarized and is not intended for distribution to other machines as-is.

## First run

There is no configuration baked into the app, so the first launch opens **Settings** instead of starting a harness. Choose where the harness runs from:

- **A local checkout** — pick the folder containing your `deepseek-harness` clone. Its frontend must already be built; if it is not, the app tells you to run `pnpm run build:web` there.
- **A managed install** — the app installs `@deepseek-ai/dsh` under `$DSH_HOME/runtimes` and runs it from there, with no checkout required.

Save, and the harness starts. Closing Settings without saving on a first run quits the app, since there is nothing yet for it to run.

### Managed installs

Saving a managed source resolves a blank version or a dist-tag like `latest` to the concrete version currently published, then installs it if it is not already under `$DSH_HOME/runtimes` — the concrete version, never the tag, is what gets written to `desktop.json`, so a later save of the same tag is a cache hit rather than a reinstall. A cold install pulls the full dependency tree and can take several minutes; Settings shows `npm install`'s output live while it runs and keeps Save disabled until it finishes. An already-installed version starts in seconds.

Opening Settings on a configured managed source also checks, in the background, whether the registry's `latest` differs from the pinned version. When it does, a hint appears next to the version field with a button to switch to it and save; the app never installs an update on its own, and a failed or offline check is silent rather than shown as an error.

## Settings

Reopen Settings any time from **File → Settings…** (⌘,), the application menu, or the tray. It is organized into four tabs — **Harness**, **Plugins**, **Notifications & Shortcuts**, and **Advanced** — reachable by click or arrow/Home/End keys. Changes take effect on save — no relaunch:

| Setting | Effect on save |
|---|---|
| Harness source, `pnpm`/`npm` path | The harness child is restarted |
| Notification port | The harness is restarted and the listener rebinds |
| Show/hide shortcut | Re-registered in place |

The notification port restart is deliberate: the port is written into the harness hook config when the child boots, so a change only reaches it through a respawn.

Settings are stored at `~/.dsh/desktop.json`, beside the harness's own state. The app writes that one file and nothing else in `~/.dsh`. You can edit it directly if you prefer:

```json
{
  "harness": { "kind": "local", "repo": "/path/to/deepseek-harness" },
  "notifyPort": 43117,
  "hotkey": "CommandOrControl+Shift+D",
  "plugins": [{ "spec": "@deepseek-ai/dsh-hooks-claude-code", "version": "0.1.1" }]
}
```

For a managed source, `harness` takes this form instead:

```json
{ "kind": "managed", "package": "@deepseek-ai/dsh", "version": "latest", "workspace": "/path/to/work/in" }
```

`pnpmPath` and `npmPath` are optional. Set them when a launch from Finder cannot find the binary — a Finder launch inherits a minimal `PATH` with no Homebrew or Corepack shim, so a packaged app often needs the absolute path from `which pnpm` or `which npm`. Running from a terminal usually does not.

Setting the path is enough on its own, but which directory the app derives `node` from differs by source. For a local source, an installed `pnpm` is itself a script that needs `node` on `PATH` to run (a `#!/usr/bin/env node` shebang, common under nvm, Homebrew, Volta, and similar layouts), and `node` normally lives right beside `pnpm` — so the app prepends `pnpm`'s own directory to the *spawned harness's* `PATH` (not the app's). For a managed source the spawned binary lives under `$DSH_HOME/runtimes`, where no `node` was installed, so that trick would find nothing beside it; the app instead prepends the resolved `npm` binary's own directory, since `node` sits beside `npm` in every layout this app supports. Either way, you do not need to add anything to your own shell `PATH` or otherwise make `node` reachable for this to work.

## Tray, shortcut, and notifications

The tray shows harness status and offers show/hide, restart, Settings, and quit. The default shortcut is **⌘⇧D**.

Turn-completion notifications need the notification hook bridge, `@deepseek-ai/dsh-hooks-claude-code` — it is pre-seeded as the first entry in the **Plugins** list below, and installs the first time you save Settings. Nothing needs to be run by hand, and nothing is written into your checkout: the bridge installs under `$DSH_HOME/runtimes`, and the app generates its hook configuration and points the harness at it at every boot. The hook is non-blocking: it exits successfully whether or not the app is listening, so it cannot disturb a running agent.

## Plugins

The **Plugins** tab has an Add field, typed the way you would type a package on a command line, plus one row per configured plugin showing its resolved version (or that it is not installed yet), whether it is pinned, and any offered update — each with its own Remove control.

```
@deepseek-ai/dsh-hooks-claude-code
@onetest/dsh-deck@0.2.1
```

- `pkg` — **floating**: resolves to the registry's current version the first time it installs, and Settings later offers an update (with its own "Use it" button on that row) without ever applying one on its own.
- `pkg@version` — **pinned**: installs exactly that version and is never offered an update.

A spec is validated the moment you click Add — a malformed spec or one naming a package already in the list is rejected right there, next to the Add field, rather than only surfacing after Save.

Each entry installs under `$DSH_HOME/runtimes` and is inserted into the harness overlay at its own resolved entry file — the same managed-install machinery a managed harness source uses, so an install is a cache hit on every later save that does not change it. A plugin that fails to install, or that cannot actually be loaded once installed (a missing dependency, most commonly), is left out of that boot's overlay with the reason shown in the tray status; it never stops the harness from starting. A plugin that requires its own configuration is a separate case the app cannot protect against yet — see Known limitations. Removing a row removes that plugin from the next boot; it does not uninstall its files from `$DSH_HOME`.

## Development

```bash
npm test           # 318 unit tests
npm run test:smoke # Playwright, against a packaged build (run `npm run pack` first)
npm run build      # compile only
```

Unit tests cover the main process — config, validation, IPC handlers, process lifecycle — and run without Electron. The smoke test launches the real packaged app, confirms it loads a harness URL, asserts the preload and renderer are actually inside the package, and checks no harness child survives the quit.

Design notes and the decisions taken while building this live in [`docs/`](docs/).

## Known limitations

- **A plugin that requires its own configuration can crash the whole boot, not just itself.** The app's own loadability check only confirms the entry file and its declared dependencies resolve — it cannot know a plugin also requires config this version has no way to supply (the way `@onetest/dsh-deck` requires a `base` route-mount path with no default). Such a plugin installs and passes that check, but cordis's own config resolution then rejects it at boot, and that rejection currently takes the whole harness process down rather than just omitting the one plugin. There is no per-plugin configuration yet, so a plugin with a required config field of its own cannot be listed safely.
- **`dsh://` links only focus the app.** The harness Web UI has no per-session URLs, so there is no address to deep-link to.
- **Unsigned and macOS-only.** No Windows or Linux packaging target is configured.
- The tray icon, menus, and shortcut have not been verified visually by an automated test — only their behavior in code.
