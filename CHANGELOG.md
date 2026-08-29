# Changelog

Notable changes to the DeepSeek Harness desktop shell. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A terminal panel with tabs**, opened from the foot of the rail. `+` opens another shell, each tab closes itself, and the `✕` at the end of the strip closes the panel with every shell in it — while the rail's button only hides it, so shells left running are still there on the way back. Each tab owns its terminal rather than sharing one and swapping buffers, so a switch keeps scrollback, selection, and cursor. It runs your login shell — or the one named under Settings → Advanced → Terminal shell — in the workspace the tree is showing, and keeps that directory: switching workspace later moves the tree, not a shell you are already working in. It takes the editor's place when the editor is closed, the whole split when the tree is closed too, and docks along the bottom (up to half the window) when both are up.

  node-pty runs in its own utility process rather than in main, the arrangement VS Code moved to after node-pty crashes took down whole windows and busy terminals blocked their event loops; here that process holds the harness views, the MCP server, and the project watcher. Output is flow-controlled on their watermarks (100000/5000/5000), so `cat` on a large file cannot outrun the panel drawing it.

  node-pty's published tarball ships `spawn-helper` without its executable bit, and every pty spawns that binary. The build repairs it before packaging — a signed bundle cannot be repaired afterwards — and a smoke test asserts it on the packaged app.

### Changed

- **Settings is two columns and flat**: the sections in a list down the left, the section itself on the right, grouped by hairlines rather than by boxes. Cards inside cards inside cards spent attention on the borders instead of the settings. A strip across the top worked at five sections and hid four of the five behind a horizontal scan every time. Each setting is now a row — what it is on the left, the control on the right — with the note that used to hide behind an ⓘ shown in full. The MCP tab's two scopes, global and per-project, each became a card carrying its own name, its file, and its own ways of adding a server; they previously appeared as five flat groups with identical controls and nothing saying which file each wrote to.

### Fixed

- **The view tools are named `mcp__desktop_views__…`**, not `mcp__desktop-views__…`. The harness publishes each MCP tool as `mcp__<server>__<tool>` and a hyphen is legal there, so the old server name produced one hyphen in a name that is otherwise all underscores — which a model normalizes, calls, and is told is an unknown tool. Observed happening in a real session.

- **Settings rendered white**, with its content scrolling through the fixed header: it mapped the harness's tokens on `:root`, one level above the `body` the vendored sheet defines them on, so every derived variable resolved to nothing.

## [0.2.0] - 2026-08-28

The first build to carry everything below. `v0.1.0` stored MCP tokens in the OS keychain and met users with a login-password prompt; this release stores them in a file at mode `0600` instead, and adds the side pane, the browser the agent can drive, and the file tree.

### Added

- **A side pane beside the harness**, laid out like an IDE mirrored: the conversation on the left, an editor in the middle, a file tree on the right, and a rail of buttons at the outside edge. Each column is draggable and remembered between launches. The editor is Monaco, appears when a file is opened rather than sitting empty, and holds a tab per file — each with its own document, so switching keeps scroll position and undo history. Files are read and written only inside a project the harness has opened, and only as text under 2MB.
- **A browser in the pane**, with back, forward, reload, and an address bar that takes a bare host — a real page in its own process, with no preload of its own. The agent reads through it (`browse_page`, `read_open_page`) and drives it through the Chrome DevTools protocol: `browser_read_page` numbers the page's controls, and `browser_click`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_drag`, `browser_upload_file`, `browser_handle_dialogs`, `browser_evaluate`, `browser_read_console`, `browser_resize`, and `browser_screenshot` act on them. Input goes through the protocol rather than through injected JavaScript, so the page receives it as the user's own — which is what native dialogs, file inputs, and drag-and-drop libraries require. Playwright's own MCP server drives a separate headless browser; every description here says which browser it means.
- **The browser waits, and says what happened behind the action.** `browser_wait_for` waits for an element or some text to appear or go, or — naming neither — for the time to pass, which is how a timed dialog is waited out and reported. Every action reports any dialog the page opened and any page the browser moved to on its own. `browser_drag` takes a pixel distance as well as a target, for a resize handle where the distance is the point. Editing shortcuts carry the command the browser's editor acts on, so `Meta+a` selects rather than merely being pressed. `window.prompt` is replaced with one that answers from the dialog policy, because Electron does not implement it and a page calling it otherwise throws.
- **The browser is driveable from the moment it exists**, rather than from the first tool call that needs it. A page opens dialogs on its own — on load, on a timer, on a link the user followed — and one that opens while nothing is attached is never answered: it blocks the page and every call after it. The attachment is also re-established if something else takes it, such as the developer tools.
- **Every browser action waits for its target to stop moving**, because a page still loading adverts moves its own controls by more than the height of one — and a click at a point measured a moment earlier lands on the control above the one that was asked for.
- **The file tree follows the disk.** A project is watched while it is open, so a file the agent writes appears without a reload. Changes are collected before the tree is redrawn, and `.git` and `node_modules` are ignored, so an install does not flood it.
- **File-type icons for JSON Lines**, and the solid folder for an expanded folder: vscode-icons draws the plain open folder as a hollow outline, which at sixteen pixels reads as an empty box beside the folders above it, and the twisty already says whether a folder is open.
- **This app's surfaces use the harness's own design tokens** and follow the harness's own Appearance setting, live: set dark in the harness and these columns turn dark with it. The token sheets are vendored (see `vendor/dsh-theme/README.md`) because the published theme package no longer ships them.
- **An update to the harness is reported in the tray**, found at startup rather than when the Settings window happens to be opened.
- **View tools for the agent**, served over MCP on loopback while the app runs: show a file in the editor, open a page in the Web tab, show a change it proposes before making it, and read what you have selected. Nothing is written to `mcp.json` — the entry is synthesized per boot, so it cannot go stale when the app is not running. Switchable off on the MCP tab.
- **A startup splash** that runs a healthcheck, installs any missing plugin with its output visible, and hands off to the harness — replacing a first launch that reported its own defaults as failures.
- **`@onetest/dsh-desktop-pane`**, a harness plugin shipped by default, putting the file tree's toggle at the foot of the harness's own sidebar. It renders only inside this app.
- **Per-project MCP servers are managed in Settings**, not just by hand: the MCP tab lists the projects the harness has opened and edits each one's `<project>/.dsh/mcp.json` with the same presets, paste field, and controls as the global list.
- **The login shell's `PATH` is resolved and cached**, so tools installed through nvm, Homebrew, or similar are reachable to the agent even though a Finder-launched app inherits only `/usr/bin:/bin:/usr/sbin:/sbin`. Resolution uses an interactive login shell, because version managers initialize in `.zshrc` rather than `.zprofile`; it costs about 2.6 seconds, so the result is cached and refreshed in the background rather than resolved on every launch. `pnpmPath` and `npmPath` still work and are still honoured, but are usually no longer necessary — and unlike them, a resolved PATH self-heals when a version manager upgrade moves the toolchain.
- **Extra PATH entries** on the Advanced tab, an override for a machine where shell resolution fails.

- **MCP servers are configured in `~/.dsh/mcp.json`**, in the standard `mcpServers` format other MCP clients use — so a block from any server's README can be pasted unmodified, and one copied out still works elsewhere. The tab gains a paste field, an add-by-hand form, and presets for Playwright, Filesystem, and Memory alongside the existing remote ones.
- **Local (stdio) MCP servers are supported**, launched as `npx`, `uvx`, `docker`, or any command. Their `env` values are carried to the server through the harness child's environment, never written into the generated overlay, which is world-readable.
- **Per-project MCP servers**, via `dsh-project-mcp-bridge` shipped as a default plugin (pinned). Drop a `.dsh/mcp.json` into a project and every session opened there gets those servers — each connected per session, with its working directory set to that session's own, so a server like Playwright writes its artifacts into the project it belongs to instead of wherever the app happened to launch. Servers configured in the MCP tab remain global and shared, and win a name collision unless the project entry sets `"override": true`.
- **A local MCP server is started before it is saved**, with its own output shown live. The harness allows a server 60 seconds to list its tools and does not expose that bound, so an `npx` server whose first run downloads its package could mount with zero tools and no error; doing the download at add time means the harness always meets a warm cache. The probe has no time limit — one would reintroduce the failure it prevents — and a server that will not start is not written, with an "Add it anyway" override for the cases where the probe is wrong.
- **The preset catalog is data**, at `assets/mcp-presets.json`, with `~/.dsh/mcp-presets.json` merged over it by id — so a wrong endpoint or a team's own servers can be fixed without an app release.

### Changed

- **MCP tokens are stored in cleartext instead of the OS keychain**, in `~/.dsh/desktop-secrets.json` at mode `0600` — the approach `.mcp.json`, `~/.aws/credentials`, `~/.npmrc`, and the `gh` CLI take. A Keychain item's ACL trusts specific signed binaries, so every re-signed build, every bundle-id change, and every separate copy of the app raised its own login-password prompt; ordinary users met that dialog several times before the app worked. The tradeoff is explicit: other accounts on the machine cannot read the file, but any process running as this user can, and it is captured by backups.
- Saving a token now reports that it is restarting the agent while it waits. The write is instant, but the call does not resolve until the harness respawns — about 17 seconds — during which the row previously showed stale text behind a disabled button.

### Removed

- The DMG is no longer signed and notarized separately from the app. Notarizing the app is what makes distribution work; the container rides along. Measured: an unsigned, unnotarized DMG holding a notarized and stapled app, carrying `com.apple.quarantine` and opened through Finder, mounts with no block and the app inside assesses as `accepted, source=Notarized Developer ID`.

### Upgrading

**MCP configuration migrates automatically** from `desktop.json` into `mcp.json` on first launch, and the old token store is removed. **Any MCP token stored by `v0.1.0` is discarded and must be re-entered once.** The two formats both look like `{"id": "string"}` — the old one holding base64 ciphertext, the new one a token — so they cannot be told apart by inspection. Reading a leftover ciphertext as a token would send it to a server as a bearer credential, so an unversioned document is discarded rather than guessed at.

## [0.1.0] - 2026-08-25

First release. Apple Silicon only.

### Added

- **Harness source** — run a local `deepseek-harness` checkout, or a managed install of the published `@deepseek-ai/dsh` package, pinned and cached under `$DSH_HOME/runtimes`.
- **Plugins** — install npm packages into the harness, each with its own configuration, with update offers for unpinned entries and per-plugin failure isolation.
- **MCP servers** — connect the agent to remote MCP servers, with presets for Tavily and GitHub. Linear and Atlassian are listed but disabled: both accept only a browser sign-in, which the app cannot do yet.
- **Notifications and shortcuts** — a turn-completion ping and a configurable global hotkey.
- **Tray and `dsh://` handler** — menu-bar presence and a URL scheme that focuses the app.
- Signed with a Developer ID and notarized, so the download opens with no warning and verifies offline.

[Unreleased]: https://github.com/onetest-ai/dsh-desktop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/onetest-ai/dsh-desktop/releases/tag/v0.1.0
