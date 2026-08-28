# DeepSeek Harness Desktop

A macOS desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI. It runs the harness as a child process, discovers the port it binds, and loads it in a native window — with a menu-bar tray, a global show/hide shortcut, turn-completion notifications, and a `dsh://` handler.

It is a **shell, not a fork**: it never modifies the harness. Point it at a checkout and `git pull` there stays clean.

> **Unofficial.** This is a community project by [OneTest AI](https://github.com/onetest-ai). It is not affiliated with, endorsed by, or supported by DeepSeek. "DeepSeek" is used here only to name the harness this application runs.

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

Use `npm run dist` for a distributable `.dmg` rather than a plain `.app` directory, or `npm run release` to sign and notarize it (see [`docs/notes/distribution.md`](docs/notes/distribution.md)).

The build is **ad-hoc signed and not notarized** unless a Developer ID identity is available (see [`docs/notes/distribution.md`](docs/notes/distribution.md)). A copy you build yourself opens normally — a local build never receives macOS's quarantine flag, so Gatekeeper never runs on it.

A copy someone *downloads* is stopped: "Apple could not verify…". They can proceed through **System Settings → Privacy & Security → Open Anyway**, or with `xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"`. Control-clicking the app and choosing *Open* no longer works — Apple removed that bypass in macOS 15.

To remove that step entirely, sign and notarize with a Developer ID: `npm run release`, with the certificate installed and notary credentials in the environment.

## First run

There is no configuration baked into the app, so the first launch opens **Settings** instead of starting a harness. Choose where the harness runs from:

- **A local checkout** — pick the folder containing your `deepseek-harness` clone. Its frontend must already be built; if it is not, the app tells you to run `pnpm run build:web` there.
- **A managed install** — the app installs `@deepseek-ai/dsh` under `$DSH_HOME/runtimes` and runs it from there, with no checkout required.

Save, and the harness starts. Closing Settings without saving on a first run quits the app, since there is nothing yet for it to run.

### Managed installs

Saving a managed source resolves a blank version or a dist-tag like `latest` to the concrete version currently published, then installs it if it is not already under `$DSH_HOME/runtimes` — the concrete version, never the tag, is what gets written to `desktop.json`, so a later save of the same tag is a cache hit rather than a reinstall. A cold install pulls the full dependency tree and can take several minutes; Settings shows `npm install`'s output live while it runs and keeps Save disabled until it finishes. An already-installed version starts in seconds.

Opening Settings on a configured managed source also checks, in the background, whether the registry's `latest` differs from the pinned version. When it does, a hint appears next to the version field with a button to switch to it and save; the app never installs an update on its own, and a failed or offline check is silent rather than shown as an error.

## Settings

Reopen Settings any time from **File → Settings…** (⌘,), the application menu, or the tray. It is organized into five tabs — **Harness**, **Plugins**, **MCP**, **Notifications & Shortcuts**, and **Advanced** — reachable by click or arrow/Home/End keys. Changes take effect on save — no relaunch:

| Setting | Effect on save |
|---|---|
| Harness source, `pnpm`/`npm` path | The harness child is restarted |
| Notification port | The harness is restarted and the listener rebinds |
| Show/hide shortcut | Re-registered in place |
| Extra PATH entries | The harness child is restarted with the new PATH |
| MCP servers | The harness child is restarted with the new server set |

The app reads your login shell's `PATH` on launch and caches it, so tools installed through nvm, Homebrew, or similar are reachable even though a Finder-launched app inherits almost no `PATH`. **Extra PATH entries** on the Advanced tab is an override for when that fails; it is not normally needed. See [`docs/notes/shell-path.md`](docs/notes/shell-path.md).

The notification port restart is deliberate: the port is written into the harness hook config when the child boots, so a change only reaches it through a respawn.

Settings are stored at `~/.dsh/desktop.json`, beside the harness's own state. The app writes that file, `~/.dsh/desktop-secrets.json` (MCP tokens, encrypted — see MCP below), `~/.dsh/runtimes` (every managed install), a symlink per linked plugin under `~/.dsh/profiles/web/node_modules`, and a copied directory per declared agent preset under `~/.dsh/.agent-presets` — see Plugins below for why both are load-bearing, not incidental; nothing else in `~/.dsh` is touched. You can edit `desktop.json` directly if you prefer:

```json
{
  "harness": { "kind": "local", "repo": "/path/to/deepseek-harness" },
  "notifyPort": 43117,
  "hotkey": "CommandOrControl+Shift+D",
  "plugins": [{ "spec": "@deepseek-ai/dsh-hooks-claude-code", "version": "0.1.1" }],
  "mcp": {
    "enabled": true,
    "servers": [{ "id": "tavily", "preset": "tavily", "url": "https://mcp.tavily.com/mcp/", "enabled": true }]
  }
}
```

Tokens are deliberately absent from that file; see MCP below.

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

Each entry installs under `$DSH_HOME/runtimes` — the same managed-install machinery a managed harness source uses, so an install is a cache hit on every later save that does not change it. At every boot, each ready entry is also symlinked into `$DSH_HOME/profiles/web/node_modules` under its own bare package name — the same directory `dsh plugin --profile web add` itself writes real installs into. This is not a display nicety: the harness's client-module registry discovers a plugin's browser bundle only by resolving the overlay's insert name as a package specifier, which an absolute path cannot satisfy — a plugin inserted by path instead of by name silently loses its entire UI while its tools keep working, with no error anywhere. Linking never touches a path that is not already this app's own symlink: a real install already at that location — the user's own `dsh plugin --profile web add`, or anything else that put a real directory there — is left completely alone, and that one entry falls back to the path-based reference instead. A plugin that declares a browser half (`dsh.client.platform` in its own `package.json`) and lost it to that fallback is not downgraded silently — it is reported by name in the tray note and on its Settings row, since tools-work-but-UI-vanished is otherwise invisible. A plugin with no browser half falls back quietly, since there is nothing to lose. The link is repointed when a pinned version changes, and removed — along with any link whose target no longer exists — for a plugin no longer configured; this reconciliation runs on every boot, not only on Settings saves, so it also cleans up after changes made outside the app.

A plugin can also ship its own agent preset — a persona and file-tool composition, distinct from its host-plane tools — by declaring `dsh.presets: "./presets"` in its `package.json`. Each immediate subdirectory of that path containing a `preset.yml` is copied into `$DSH_HOME/.agent-presets/<dirname>/` at boot, the only root besides the harness's own shipped presets that `@deepseek-ai/dsh-agent-presets` discovers — a plugin cannot add its own root by patch. A copied preset lands with `trust: user`, writable and deletable like anything else the user owns. The app never overwrites a directory it did not itself create there: your own hand-authored preset of the same id always wins, and the plugin's is simply not installed. Presets are reconciled the same way and at the same time as plugin links — pruned when their plugin is no longer configured, re-copied when its version changes.

A plugin that fails to install, or that cannot actually be loaded once installed (a missing dependency, most commonly), is left out of that boot's overlay with the reason shown in the tray status; it never stops the harness from starting. A plugin that requires its own configuration is a separate case the app cannot protect against yet — see Known limitations. Removing a row removes that plugin from the next boot; it does not uninstall its files from `$DSH_HOME`.

## MCP

The **MCP** tab connects the agent to [Model Context Protocol](https://modelcontextprotocol.io/) servers — local ones it launches (`npx`, `uvx`, `docker`) and remote ones it calls over HTTPS. Each enabled server becomes its own `@deepseek-ai/dsh-mcp-client` instance in the harness, and its tools reach the model under that server's own name.

Configuration lives in `~/.dsh/mcp.json`, in the same `mcpServers` format Claude Desktop, Cursor, and VS Code use:

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "tavily": { "type": "http", "url": "https://mcp.tavily.com/mcp/", "headers": { "Authorization": "Bearer tvly-…" } }
  }
}
```

That means **you can paste the block from any server's README unmodified** — the tab has a field for exactly that — and a block copied out still works in another client. Presets are offered for Tavily, GitHub, Playwright, Filesystem, and Memory; anything else can be added by hand or by paste. **Linear** and **Atlassian** are listed but not selectable: both accept only a browser sign-in, which this app cannot do yet.

The master switch is off by default. With it off nothing is installed, no server is contacted, and no tool schemas enter the model's context. Adding your first server turns it on for you, and a servers-configured-but-switched-off state says so rather than looking configured and doing nothing.

Servers save as soon as you change them; the switch saves with the rest of the form. A save restarts the agent, which takes some seconds — the tab says so while it waits.

**Tokens are stored in the clear**, inline in `mcp.json` at mode `0600`, the same approach as `.mcp.json`, `~/.aws/credentials`, and the `gh` CLI. The OS keychain was tried and dropped: it re-prompts for your login password on every re-signed build and every copy of the app. Any process running as your user can read that file, and it is captured by backups. The generated harness overlay never contains a credential — it refers to each by environment variable — because that file is world-readable.

**Servers configured here are global** — one process shared by every session, so a server that writes files uses a single directory for all of them. For a server that should follow the project, put it in `<project>/.dsh/mcp.json` instead: the bundled `dsh-project-mcp-bridge` plugin gives every session of that project its own process, running in that project's directory. This is what keeps Playwright's screenshots and logs in the project they belong to. A global server of the same name wins unless the project entry sets `"override": true`.

Presets come from `assets/mcp-presets.json`, and `~/.dsh/mcp-presets.json` merges over it by id, so a wrong endpoint or a team's internal servers can be fixed without waiting for an app release.

Details are in [`docs/notes/mcp-servers.md`](docs/notes/mcp-servers.md).

## The side pane

Beside the harness the app keeps columns of its own: an editor in the middle, a file tree on the right, and a rail of buttons at the outside edge — the mirror of an IDE, with the conversation where the sidebar usually is.

The tree shows the project the harness is working in — it follows the file you open, and otherwise the harness's own workspace activity, so there is no picker to keep in sync. **New file** and **New folder** sit in its header: the entry is named where it will appear, and a new file opens straight away. Images, video, audio, and PDFs open in a tab of their own rather than being refused as "not text". Clicking a file opens it in the editor, which is Monaco: syntax highlighting, find and replace, and the TypeScript and JSON language services. Several files can be open at once, one tab each, and every tab keeps its own document — so switching between them keeps your scroll position and your undo history. `Cmd+S` saves; a tab with unsaved edits shows a dot instead of its close button. A file changed on disk reloads, unless you have unsaved edits in it, in which case it says so and leaves your work alone.

The **Web** tab is a browser with back, forward, reload, and an address bar that takes a bare host. It is a real page in its own process, not a frame.

Open the tree and the browser from the rail, or from **View** (`Cmd+Alt+B` and `Cmd+Alt+W`). The editor has no toggle of its own: it appears when a file is opened, and closes when its last tab does. Every column remembers its width.

Right-click any row in the tree for **New File**, **New Folder**, **Rename**, **Delete**, **Copy**, **Cut**, **Paste**, **Copy Path**, **Reveal in Finder**, and **Add to Chat** — which drops the file's path into the harness's message box, and is the one thing that needs the `@onetest/dsh-desktop-pane` plugin (installed by default).

All of it draws in the harness's own design tokens and follows the harness's own **Appearance** setting — set dark there and these columns turn dark with it, without a restart.

The agent can drive these views through a set of tools, served over MCP on `127.0.0.1` for as long as the app is running:

| Tool | What it does |
| --- | --- |
| `view_open_file` | Shows a file in the editor. |
| `view_open_url` | Loads an `http`/`https` page in the Web tab. |
| `browse_page` | Opens a URL **and reads it back as text** — the agent's way to read the web through a real browser rather than a plain fetch. |
| `read_open_page` | Reads whatever the browser is showing, including a page you navigated to yourself. |
| `view_show_diff` | Shows a file beside the text the agent proposes for it, before anything is written. |
| `view_get_selection` | Reads what you have selected in the editor. |

The browser can also be **driven**, through the Chrome DevTools protocol — the same protocol Playwright speaks — so a page cannot tell the input from your own:

| Tool | What it does |
| --- | --- |
| `browser_read_page` | Numbers every interactive element with its role, name, id, and value. The numbers (`ref=N`) are how the tools below name an element, and they beat a CSS selector guessed from memory. |
| `browser_click`, `browser_hover` | Clicks or hovers, at the element's place on screen. |
| `browser_type`, `browser_press_key` | Types key by key, so pickers and autocompletes react; presses `Enter`, `Tab`, `Control+a`. |
| `browser_select_option` | Chooses in a native `<select>`, by value or by the label you read. |
| `browser_drag` | Presses, moves across in steps, releases — what a sortable list or a resize handle actually waits for. |
| `browser_upload_file` | Puts a file on a file input without a chooser. The file must be inside an open project. |
| `browser_handle_dialogs` | Decides what happens to `alert`, `confirm`, and `prompt`. They are dismissed by default and always answered at once, since a dialog left open blocks the page; whatever appeared is reported with the action that caused it. |
| `browser_evaluate` | Runs an expression in the page — for state the rendered text does not show, such as an input's `.value` or a `getBoundingClientRect()`. |
| `browser_read_console` | Reads what the page logged, uncaught exceptions included. |
| `browser_resize` | Overrides the viewport the page measures, without moving the window you arranged. |
| `browser_screenshot` | Captures the page as a PNG. |

There are two browsers in reach, and their tools carry the same names: these drive **this app's** browser, the one on your screen, while Playwright's MCP server drives a separate headless one. Every description here says which, so the model does not reach for the wrong one.

Every path argument is checked against the projects the harness has opened, and a path outside them is refused with a reason the model can read. Nothing is written to `mcp.json`: the server entry is built per launch, so it cannot linger when the app is not running. Switch the whole thing off on the **MCP** tab.

## Development

```bash
npm test           # 675 unit tests
npm run test:smoke # Playwright, against a packaged build (run `npm run pack` first)
npm run build      # compile only
```

Unit tests cover the main process — config, validation, IPC handlers, process lifecycle — and run without Electron. The smoke test launches the real packaged app, confirms it loads a harness URL, asserts the preload and renderer are actually inside the package, and checks no harness child survives the quit.

Design notes and the decisions taken while building this live in [`docs/`](docs/).

## Known limitations

- **A plugin that requires its own configuration can crash the whole boot, not just itself.** The app's own loadability check only confirms the entry file and its declared dependencies resolve — it cannot know a plugin also requires config this version has no way to supply (the way `@onetest/dsh-deck` requires a `base` route-mount path with no default). Such a plugin installs and passes that check, but cordis's own config resolution then rejects it at boot, and that rejection currently takes the whole harness process down rather than just omitting the one plugin. There is no per-plugin configuration yet, so a plugin with a required config field of its own cannot be listed safely.
- **MCP servers needing a browser sign-in cannot be added.** Linear, Atlassian, and any other OAuth-only server are listed but disabled. The MCP specification defines authorization generically and the SDK already implements it, so this is one generic flow rather than per-vendor work — but a desktop redirect URI has to be settled first.
- **A local MCP server whose first run downloads its package can start with no tools.** `npx -y <package>` fetches on first use, and the MCP client waits for the server's tool list on a 60-second budget the harness does not expose. Exceed it and the server connects with zero tools and no obvious error. Pre-install the package, or give an absolute command path.
- **`dsh://` links only focus the app.** The harness Web UI has no per-session URLs, so there is no address to deep-link to.
- **Not notarized by default, and macOS-only.** Builds are ad-hoc signed, so a downloaded copy needs one trip through System Settings before it opens; `npm run release` removes that with a Developer ID. No Windows or Linux packaging target is configured.
- The tray icon, menus, and shortcut have not been verified visually by an automated test — only their behavior in code.

## Releases

Released builds are on the [releases page](https://github.com/onetest-ai/dsh-desktop/releases); what has landed since the last one is in [`CHANGELOG.md`](CHANGELOG.md).

Cutting one: `npm run release` (with a Developer ID certificate installed and notary credentials in the environment) produces a signed, notarized, stapled `.dmg` under `release/`. Attach it to a GitHub release — never commit it, since GitHub rejects files over 100MB and a binary in git history is permanent.

## Contributing

Issues and pull requests are welcome at [onetest-ai/dsh-desktop](https://github.com/onetest-ai/dsh-desktop).

Before opening a PR, run the checks the project holds itself to:

```bash
npm test           # unit tests; no Electron required
npm run build      # typecheck and compile
npm run pack && npm run test:smoke   # the packaged app, end to end
```

Two conventions carry most of the weight here, both visible throughout the codebase:

- **Every non-obvious contract is documented where it is declared** — JSDoc on exports, with the reasoning that is not recoverable from the code itself. Comments state facts and consequences, not narration.
- **Tests describe behavior, and are proven non-vacuous.** This project has caught more than one test that passed unconditionally; when a test guards something important, break the code deliberately and confirm the test fails.

Rulings made during development, including the ones that turned out to be wrong, are kept in [`docs/decisions.md`](docs/decisions.md). Design notes per feature live in [`docs/notes/`](docs/notes/).

## License

[MIT](LICENSE) © OneTest AI
