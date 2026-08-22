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

Reopen Settings any time from **File → Settings…** (⌘,), the application menu, or the tray. Changes take effect on save — no relaunch:

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
  "hotkey": "CommandOrControl+Shift+D"
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

Turn-completion notifications need one extra step — the harness must be told to run the hook the app listens for:

```bash
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code
```

That writes into `~/.dsh`, not into your checkout. The app generates the hook configuration itself at boot and points the harness at it. The hook is non-blocking: it exits successfully whether or not the app is listening, so it cannot disturb a running agent.

Note this applies to **every** `dsh web` you run afterwards, not only this app. To undo it, `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-hooks-claude-code`.

## Development

```bash
npm test           # 181 unit tests
npm run test:smoke # Playwright, against a packaged build (run `npm run pack` first)
npm run build      # compile only
```

Unit tests cover the main process — config, validation, IPC handlers, process lifecycle — and run without Electron. The smoke test launches the real packaged app, confirms it loads a harness URL, asserts the preload and renderer are actually inside the package, and checks no harness child survives the quit.

Design notes and the decisions taken while building this live in [`docs/`](docs/).

## Known limitations

- **`dsh://` links only focus the app.** The harness Web UI has no per-session URLs, so there is no address to deep-link to.
- **Unsigned and macOS-only.** No Windows or Linux packaging target is configured.
- The tray icon, menus, and shortcut have not been verified visually by an automated test — only their behavior in code.
