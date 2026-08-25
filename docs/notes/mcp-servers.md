# MCP servers

How the MCP tab mounts remote [Model Context Protocol](https://modelcontextprotocol.io/) servers into the harness, and why each part sits where it does.

## The problem the plugin list could not solve

A server is already expressible as a plugin entry: `@deepseek-ai/dsh-mcp-client` takes one server's transport, URL, and headers as its config, and this app already installs a package and mounts it with a config (`plugin-entries.ts`). What it cannot express is *two* servers. One package backs every server, and the plugin list is one entry per package — `settings-validate.ts`'s `parsePluginsField` rejects a duplicate, and `runtime-files.ts`'s `insertId` derives the overlay row id from the package name, so two entries would collide even if the list allowed them.

So MCP is its own config section (`DesktopConfig.mcp`) rather than a plugin entry, and the tab is its own tab. The user-facing difference matches: a plugin is a package you name, a server is a URL and a credential.

## One entry, many rows

`patchOverlay` already supports one ready entry contributing several rows with ids of its own choosing — the `declaredPatch` path, built for a package that declares its own mount. MCP reuses it: `index.ts`'s `resolveDeclaredPatch` returns `serverRows(config.mcp)` for the MCP client package instead of reading that package's manifest, so N servers become N rows under `mcp-<id>`, all naming the same package.

Nothing in `runtime-files.ts` changed for this. The synthesized-row path would not have worked: it takes its id from the package name, and it serializes `config` as JSON, which cannot express the `!!js` expression below.

`attributeBootFailure` still attributes correctly with several rows sharing a `name`: it maps matched rows to their *package*, and all of them carry the same one.

## The token never touches disk in cleartext

The generated overlay is rewritten on every boot and sits in a plain file, so it names the token instead of carrying it:

```yaml
- id: mcp-tavily
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: tavily
    transport: streamable-http
    url: https://mcp.tavily.com/mcp/
    headers:
      Authorization: !!js '`Bearer ${process.env.DSH_MCP_TOKEN_TAVILY}`'
```

The harness's own cordis loader evaluates `!!js` under a plugin entry's `config`, in the harness child — this app writes the expression and never evaluates it (`bundle-patch.ts`'s `jsExpression`). The value arrives through the child's environment, built by `serverEnv` and passed to `dshWebCommand`'s `extraEnv`.

The expression needs no `undefined` guard: `serverEnv` defines a variable for every server a row is emitted for, empty when no token is stored, and the two are generated together for the same boot. A missing token therefore produces the server's own `401` rather than a header reading `Bearer undefined`.

## Where the token lives

`secrets.ts`, over Electron's `safeStorage` — which is already the per-platform abstraction: Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux, selected by Electron itself. No second layer of platform selection exists here, and none should be added; writing one would re-implement Chromium's OS crypto integration worse.

Ciphertext goes in `$DSH_HOME/desktop-secrets.json`, mode `0600`, deliberately not in `desktop.json`: that file is hand-editable and the Settings window has a button that opens it.

On a Linux desktop with no keyring, `isEncryptionAvailable()` is false and the backend degrades to `basic_text`, which is not encryption. `setSecret` refuses rather than writing a plaintext secret into a file named as though it were protected; the tab disables its token fields and says so. Windows and macOS never reach this. The escape hatch for that case is setting `DSH_MCP_TOKEN_<NAME>` in the environment the app is launched from, since that is where the token ends up anyway.

Tokens are write-only from the renderer's side. `read` reports *whether* each server has one, never the value (`McpInfo.tokens`), so a stored credential cannot be recovered through the settings window.

## The client is not a plugin the user manages

`@deepseek-ai/dsh-mcp-client` is refused by the Plugins tab's Add control, filtered out of the list it shows, dropped from `plugins` on save, and skipped when boot derives statuses. A bare entry for it has no config, which cordis rejects at load — so before this, adding it there produced a permanently failing row offering a Config editor for something only the MCP tab can fill in.

Four layers because the entry can arrive by hand edit or predate the MCP tab, and each answers a different moment: adding, showing, persisting, booting.

## Two switches, both required

The master switch and each server's own switch both gate mounting (`activeServers`). A server enabled under a switched-off feature installs nothing and contributes no row — which is a state the tab used to reach silently, with a token saved and nothing connected. Adding the first server now turns the feature on, and a servers-listed-but-feature-off state carries a standing warning.

## Presets are data

`mcp-presets.ts` is a table: id, label, URL, docs link, and how the server authenticates. Adding a vendor is one row.

The `auth` field is what makes the table load-bearing. A `token` preset accepts a long-lived credential the user can paste. An `oauth` preset issues none at all — probed directly, each answers an unauthenticated `initialize` with `WWW-Authenticate: Bearer realm="OAuth"` and no other accepted scheme:

| Server | Endpoint | Result |
|---|---|---|
| Tavily | `https://mcp.tavily.com/mcp/` | 401, also accepts a pasted API key |
| GitHub | `https://api.githubcopilot.com/mcp/` | 401, also accepts a pasted PAT |
| Linear | `https://mcp.linear.app/mcp` | 401 `realm="OAuth"` — no pasteable token |
| Atlassian | `https://mcp.atlassian.com/v1/mcp` | 401 `realm="OAuth"` — no pasteable token |

Linear and Atlassian ship in the catalog but are listed disabled, labelled as needing a sign-in this app cannot do yet. Hiding them would leave a user who looks for Linear unsure whether they typed the name wrong; giving them a token field would be a dead end discovered only after pasting something.

## Not done yet: OAuth

The MCP specification defines authorization generically — protected-resource metadata discovery (RFC 9728), authorization-server discovery, dynamic client registration (RFC 7591), PKCE, token exchange, refresh — and `@modelcontextprotocol/sdk` implements all of it in `client/auth.js`. So supporting Linear, Atlassian, GitHub-over-OAuth, Notion and every future compliant server is **one** generic `OAuthClientProvider` backed by this app's own secret store, not per-vendor work. A preset would still need no vendor code.

The open design question is the redirect URI, which a desktop app has to answer one of two ways — a transient loopback listener, or a paste-the-code flow. That decision is what the follow-up owes; the catalog, the row generation, and the secret store are all already shaped to take it.
