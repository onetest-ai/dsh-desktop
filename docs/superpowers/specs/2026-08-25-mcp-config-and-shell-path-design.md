# Shell PATH resolution and standard MCP configuration — design

Two sequenced changes to `dsh-desktop`. Each ships working software on its own; the second is close to useless without the first, so they land in order.

## Problem

**PATH.** A Finder-launched macOS app inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Measured on the development machine: `npx` lives in `~/.nvm/versions/node/v24.15.0/bin`, `uvx` in `/opt/homebrew/bin`, `docker` in `/usr/local/bin` — none reachable. The app already carries two hand-rolled workarounds for this one root cause: `resolveBinary` detects the minimal PATH and tells the user to hardcode an absolute path, and `envWithLauncherDir` prepends the launcher's own directory so the shebang `node` lookup resolves one level down. Those absolute paths are version-pinned (`.../v24.15.0/bin/pnpm`) and break on the next `nvm install`.

Every stdio MCP server is launched as `npx …`, `uvx …`, or `docker …`, so stdio support is unreachable until this is fixed.

**MCP configuration.** The app models an MCP server as `{id, preset?, url, enabled}` — Streamable HTTP only. Stdio servers need `command`, `args`, `env`, `cwd`. More importantly, every MCP server's README ships a `mcpServers` JSON block, and users expect to paste it. The current shape cannot accept one.

## Measurements this design rests on

| Question | Answer |
|---|---|
| GUI-launched PATH | `/usr/bin:/bin:/usr/sbin:/sbin` |
| `$SHELL -c` | 96 ms, finds neither nvm nor Homebrew |
| `$SHELL -lc` | 132 ms, misses nvm (nvm init lives in `.zshrc`, not `.zprofile`) |
| `$SHELL -ilc` | **2599 ms**, finds nvm and Homebrew |
| Generated overlay permissions | `0644` |
| `desktop-secrets.json` permissions | `0600` |
| Harness plugin stdio support | complete — `command`, `args`, `env`, `cwd` |
| Inherited-env scrub in the harness | `/KEY\|PASSWORD\|SECRET\|TOKEN/i` dropped; explicit `env` merges after |
| A real stdio server end to end | `@modelcontextprotocol/server-memory` handshakes, 9 tools |

Only an interactive login shell finds nvm, and it costs 2.6 s — too slow to pay on every launch. Therefore: resolve once, cache, use the cache immediately, refresh in the background.

## Change 1 — shell PATH resolution

Resolve the user's login-shell PATH once and cache it. At launch the cached value is used immediately, and a refresh runs in the background so a `nvm install` self-heals by the next start.

- **Cache**: `$DSH_HOME/shell-path.json`, `{version: 1, path: string, shell: string, resolvedAt: string}`. Separate from `desktop.json`, which is hand-edited and user-owned; this is derived state the app may rewrite at will.
- **Resolution**: `$SHELL -ilc 'echo $PATH'` with a **10-second** hard timeout and an empty environment except `HOME` and `TERM`. A shell that hangs, exits non-zero, or prints nothing leaves the cache untouched.
- **Consumption**: the resolved PATH is prepended to the harness child's environment in `dshWebCommand`, ahead of `envWithLauncherDir`'s entry, so the launcher directory still wins for the launcher itself.
- **Manual override**: a new `extraPath` field in `desktop.json`, edited on the Advanced tab. When set it is prepended ahead of the resolved PATH. It is an override for when resolution fails, not the mechanism.
- `pnpmPath`/`npmPath` are untouched. They keep working, and become unnecessary for most users rather than being removed — removing them is a separate decision with its own migration.

Failure is non-fatal at every step: no cache and no override means today's behaviour exactly.

## Change 2 — `mcp.json` in the standard format

MCP configuration moves out of `desktop.json` into `$DSH_HOME/mcp.json`, in the same `mcpServers` shape Claude Desktop, Cursor, and VS Code use.

```json
{
  "mcpServers": {
    "tavily": { "type": "http", "url": "https://mcp.tavily.com/mcp/", "headers": { "Authorization": "Bearer tvly-…" } },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"], "env": {}, "cwd": "/path" }
  }
}
```

**JSON, not YAML.** Every README snippet is JSON; "just copy" is the entire point.

**Keys.** `command`, `args`, `env`, `cwd` for stdio; `type`, `url`, `headers` for HTTP. A server with `command` is stdio; one with `url` is HTTP. Unknown keys are preserved on write so a block carrying fields this app does not model survives a round trip.

**Enable/disable** uses `"disabled": true` on the entry — the de-facto extension other tools ignore, so a block copied out still works elsewhere and one copied in still works here. The master switch stays in `desktop.json`: it is an app-level toggle, not server configuration.

**Secrets are inline**, consistent with the decision to store tokens in cleartext, and it is what makes a pasted block work unmodified. `desktop-secrets.json` is retired. `mcp.json` is written `0600`.

**The overlay still uses `!!js process.env` indirection.** The generated overlay is written `0644`; inlining credentials there would downgrade them from owner-only to readable by any local account. The app reads `mcp.json`, passes values through the harness child's environment, and the overlay names them.

**Entry points.** Presets (curated, growing) fill the form with one click; "Add custom" offers stdio or HTTP; "Paste JSON" accepts a whole `mcpServers` block and creates however many servers it names. All three write the same file, which the user may also hand-edit.

**Migration** runs once: `desktop.json`'s `mcp` section plus `desktop-secrets.json` become `mcp.json`, and both old sources are removed.

## Known limitation, documented not solved

`npx -y <package>` downloads on first run. The MCP client awaits `listTools()` during plugin activation on the SDK's 60-second default, which the harness does not expose as configuration. A cold fetch that exceeds it activates the server with **zero tools** and no obvious error. Recorded in the README's Known limitations; a pre-flight "test this server" button is a candidate follow-up, not part of this work.

## Out of scope

- Per-server forms generated from a server's own settings. MCP has no configuration-schema discovery, so this would be permanent per-server curation. Servers with many options (XcodeBuildMCP has 23) configure themselves through env, flags, and their own project-local files.
- OAuth for MCP servers that accept no pasteable token (Linear, Atlassian).
- Removing `pnpmPath`/`npmPath`.
