# Changelog

Notable changes to the DeepSeek Harness desktop shell. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing here has shipped in a downloadable build yet. The `v0.1.0` DMG still stores MCP tokens in the OS keychain, so anyone using it meets the login-password prompt described below until a release carries these changes.

### Added

- **The login shell's `PATH` is resolved and cached**, so tools installed through nvm, Homebrew, or similar are reachable to the agent even though a Finder-launched app inherits only `/usr/bin:/bin:/usr/sbin:/sbin`. Resolution uses an interactive login shell, because version managers initialize in `.zshrc` rather than `.zprofile`; it costs about 2.6 seconds, so the result is cached and refreshed in the background rather than resolved on every launch. `pnpmPath` and `npmPath` still work and are still honoured, but are usually no longer necessary — and unlike them, a resolved PATH self-heals when a version manager upgrade moves the toolchain.
- **Extra PATH entries** on the Advanced tab, an override for a machine where shell resolution fails.

### Added

- **MCP servers are configured in `~/.dsh/mcp.json`**, in the standard `mcpServers` format other MCP clients use — so a block from any server's README can be pasted unmodified, and one copied out still works elsewhere. The tab gains a paste field, an add-by-hand form, and presets for Playwright, Filesystem, and Memory alongside the existing remote ones.
- **Local (stdio) MCP servers are supported**, launched as `npx`, `uvx`, `docker`, or any command. Their `env` values are carried to the server through the harness child's environment, never written into the generated overlay, which is world-readable.
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
