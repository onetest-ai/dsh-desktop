# MCP servers

How MCP servers are configured, why the configuration is a standard file, and why credentials never reach the generated overlay.

## `mcp.json`, in the format everyone else uses

Configuration lives in `$DSH_HOME/mcp.json`, in the same `mcpServers` shape Claude Desktop, Cursor, and VS Code take:

```json
{
  "mcpServers": {
    "tavily":     { "type": "http", "url": "https://mcp.tavily.com/mcp/", "headers": { "Authorization": "Bearer tvly-…" } },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```

JSON, not YAML: every server's README publishes JSON, and "paste the block from the docs" is the whole point. A block copied in works unmodified; a block copied out still works in another client.

**Transport is inferred** from `command` or `url` rather than read from `type`. Most published blocks omit that key, so trusting it would reject the majority of real configurations.

**Unknown keys survive a round trip.** A block may carry fields belonging to other clients (`autoApprove`, `timeout`); dropping them on write would silently degrade a config the user pasted from somewhere and may paste back.

**`disabled: true` marks a server off.** The standard format has no enabled field, but `disabled` is the de-facto extension other clients ignore, so the file stays portable in both directions. The app-level master switch is not here — it lives in `desktop.json`, because it is a property of this app, not of any server.

## What is not in `mcp.json`

The master switch and the resolved MCP client version stay in `desktop.json`. The first is an app toggle; the second is app state that means nothing to another MCP client and would be noise in a file meant to be shared.

## Credentials

Tokens are stored **in the clear**, inline, at mode `0600` — the same thing `.mcp.json`, `~/.aws/credentials`, `~/.npmrc`, and the `gh` CLI do, and what makes a pasted block work unmodified.

Do not reintroduce OS-keychain storage. It was tried and removed: a keychain item's ACL trusts specific signed binaries, so every re-signed build, every bundle-id change, and every separate copy of the app raised its own login-password prompt. Ordinary users met that dialog several times before the app worked, which is a bad trade for a developer tool whose agent already runs shell commands as them.

`0600` does not restrict the app or the user's editor — both run as that user. It keeps other accounts on the machine out, which is all cleartext storage can offer. One caveat: an editor that saves by writing a temp file and renaming may replace the file with its own default mode, often `0644`. The app restores `0600` on its next write, but not instantly.

### Why the overlay still uses `!!js`

The generated harness overlay is written `0644`. Putting credentials in it would downgrade them from owner-only to readable by any local account. So every `env` value and every `headers` value is replaced in the overlay by a `!!js process.env.…` lookup, and the app passes the literal values through the harness child's environment instead:

```yaml
- id: mcp-tavily
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: tavily
    transport: streamable-http
    url: https://mcp.tavily.com/mcp/
    headers:
      Authorization: !!js process.env.DSH_MCP_0_AUTHORIZATION
```

Applied to **every** value, not only the ones that look secret: which values are sensitive is not knowable from a key name.

**The variable names lead with the server's index.** Sanitizing a name and a key into one identifier can collide — server `a-b` key `c` and server `a` key `b-c` both become `A_B_C` — and a collision would hand one server another's credential. The sanitized suffix survives only so the variable is recognizable while debugging.

The harness scrubs `/KEY|PASSWORD|SECRET|TOKEN/i` from what a child inherits, but explicit `env` merges *after* that scrub, so the injected values land while the `DSH_MCP_*` variables themselves are scrubbed out of the MCP server's own environment.

## Rows, not one plugin

`patchOverlay`'s `declaredPatch` path emits one `@deepseek-ai/dsh-mcp-client` row per active server, each under `mcp-<name>`. The synthesized-row path would not do: it takes its id from the package name, which collides on the second server, and serializes `config` as JSON, which cannot express `!!js`.

The MCP client package is refused by the Plugins tab, hidden from that list, and skipped at boot. A bare entry for it carries no config, which cordis rejects at load.

## Presets

The catalog is `assets/mcp-presets.json` — data, not code. `assets/**` is already in electron-builder's `files`, so it ships with no build step; because nothing type-checks it any more, `tests/smoke.spec.ts` asserts it is actually inside the package, and that assertion is proven by removing the file and watching the test fail.

`$DSH_HOME/mcp-presets.json` merges over it **by id**. That is what makes the catalog updatable without an app release: correcting a vendor's endpoint, or handing a team its own internal servers.

A preset names a command to run, so a **remote** catalog is deliberately out of scope — fetching one would be arbitrary code execution at app start. A local file carries exactly the trust its own user already has over `mcp.json`.

Presets that accept only a browser sign-in (Linear, Atlassian) are listed and disabled, with the reason shown, rather than hidden: a user looking for Linear should learn it is known and unsupported.

## Two things the tab has to say out loud

**Servers save immediately, the switch saves with the form.** They live in different files, and `save` writes only `desktop.json`.

**A write does not resolve until the harness respawns** — measured at around 17 seconds. The tab says so while it waits; without that it sits on stale rows behind disabled controls and reads as nothing happening.

## Preparing a server before it is written

Adding a local server starts it first: the app spawns the command, completes a real MCP `initialize` and `tools/list`, and streams the server's own stderr into the tab — which is where `npx` reports a first-run download. Only then is `mcp.json` written.

This exists because of the ceiling below. The harness gives a server 60 seconds to list its tools and does not expose that bound, so an `npx` server whose first run downloads its package can mount with **zero tools and no error**. Doing the download here means the harness always meets a warm cache.

The probe is deliberately **unbounded in time**. A timeout here would reintroduce exactly the failure it exists to prevent — a server that would have worked, reported as broken because a timer expired. Its children are spawned into their own process group and reaped through the same `stopGroup` the harness child uses, because a probed server may itself launch a browser or a language server.

A failed probe does **not** write the server: one that cannot start would otherwise sit in the list looking configured while contributing nothing. "Add it anyway" is offered beside the error, because a probe can be wrong — a server needing credentials the window has not collected yet will refuse to start and still be worth saving. The refusal is a default, never a wall.

Remote servers skip it: nothing to download, no local process to prove.

### A `<select>` loses its selection when its options are replaced

`renderPresetPicker` runs on the picker's own `change` event and rebuilds its options, which resets `value` to the first entry. Choosing "Memory" and pressing Add therefore added Tavily. The selection is captured before the rebuild and reapplied after.

The unit suite could not see this: its fake DOM kept `value` across a `textContent = ''`, so the bug was invisible there and only the packaged app exposed it. The fake now models the real behaviour — an element's tag comes from the markup, and clearing a `select` clears its value — so this class of bug is catchable at the unit layer from here on.

## Known limitation: the cold-start ceiling

`npx -y <package>` downloads on first run. The MCP client awaits `listTools()` during plugin activation on the SDK's 60-second default, which the harness does not expose as configuration. A cold fetch that exceeds it activates the server with **zero tools and no obvious error**. Pre-installing the package, or pinning an absolute command path, avoids it.
