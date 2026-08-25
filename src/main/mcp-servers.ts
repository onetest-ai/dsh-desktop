import { jsExpression, type DeclaredPatchRow } from './bundle-patch'
import { findPreset } from './mcp-presets'

/** The MCP client plugin one instance of which this app mounts per configured server. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * One configured MCP server.
 *
 * `id` is the user-facing identity and does three jobs at once: it names the
 * server's tool namespace inside the harness (the model sees
 * `mcp__<id>__<tool>`), it keys the server's stored token, and it derives the
 * overlay row id. Those must agree, so there is one field rather than three.
 *
 * `preset` records which shipped preset the entry came from, kept so the
 * settings window can show the vendor's own label and credential name. It is
 * absent for a hand-added server, which is why `url` is stored on the entry
 * rather than looked up: a preset's URL is a default at add time, not a
 * binding the entry defers to forever.
 */
export interface McpServer {
  id: string
  preset?: string
  url: string
  enabled: boolean
}

/**
 * The `mcp` section of `desktop.json`.
 *
 * `enabled` is the master switch, deliberately separate from each server's
 * own: turning MCP off must not lose which servers were configured, and a
 * user turning it back on should get what they had. With it off, no MCP row
 * reaches the overlay at all, so the harness pays nothing — no connection, no
 * tool schemas in the model's request.
 *
 * `clientVersion` is the concrete resolved version of `MCP_CLIENT_PACKAGE`
 * this app installed, the same field and meaning as a plugin entry's
 * `version` (see `plugin-entries.ts`). Absent until a save has installed it
 * at least once.
 */
export interface McpConfig {
  enabled: boolean
  clientVersion?: string
  servers: McpServer[]
}

/**
 * Shape of a valid server id: what is safe as a tool namespace, an
 * environment-variable stem, a YAML row id, and a secrets-file key at once.
 *
 * Narrower than any single one of those needs, because the id is all of them
 * — and it matches the harness's own `serverName` rule
 * (`[A-Za-z0-9_-]{1,32}`, see `packages/mcp/mcp-client/README.md` in the
 * deepseek-harness repo), so an id this app accepts can never be rejected
 * downstream by the plugin it configures.
 */
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Whether a server id is usable everywhere it has to be.
 * @param id - the candidate id.
 * @returns whether the id is safe to store and later expand.
 */
export function validServerId(id: string): boolean {
  return SERVER_ID_PATTERN.test(id)
}

/**
 * Whether a server URL is one this app will mount.
 *
 * Restricted to `https`, not merely to a parseable URL: every credential this
 * app stores travels to that URL as a bearer token, and `http` would put it
 * on the wire in cleartext. A preset can never introduce one (each is checked
 * by `mcp-presets.spec.ts`), but a hand-added server or a hand-edited
 * `desktop.json` can, and both reach here.
 * @param url - the candidate URL.
 * @returns whether the URL is an absolute https URL.
 */
export function validServerUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The environment variable through which one server's token reaches the
 * harness child.
 *
 * The token is passed by environment rather than written into the generated
 * overlay, so the credential never lands on disk in cleartext: the overlay
 * file names this variable through a `!!js` expression and the harness's own
 * loader resolves it in the child process (see `serverRow`).
 * @param id - the server id.
 * @returns the variable name, e.g. `DSH_MCP_TOKEN_TAVILY`.
 */
export function serverEnvVar(id: string): string {
  return `DSH_MCP_TOKEN_${id.replaceAll('-', '_').toUpperCase()}`
}

/**
 * The overlay row id for one server.
 * @param id - the server id.
 * @returns the row id, namespaced so it can never collide with a plugin
 *   entry's own `insertId`-derived id.
 */
export function serverRowId(id: string): string {
  return `mcp-${id}`
}

/**
 * The servers a boot should actually mount: every enabled server, and none
 * at all when the master switch is off.
 * @param mcp - the `mcp` config section, absent on a config that predates it.
 * @returns the servers to mount, in configured order.
 */
export function activeServers(mcp: McpConfig | undefined): McpServer[] {
  if (mcp === undefined || !mcp.enabled) return []
  return mcp.servers.filter((server) => server.enabled)
}

/**
 * One server's overlay row: an `@deepseek-ai/dsh-mcp-client` instance
 * configured to reach it.
 *
 * The `Bearer` expression needs no `undefined` guard: `serverEnv` defines a
 * variable for every server this function emits a row for, empty when no token
 * is stored, and the two are always generated together for the same boot.
 *
 * Emitted as a declared-patch row rather than through `patchOverlay`'s
 * synthesized-row path for two reasons that both matter here: a synthesized
 * row takes its id from the package name, which would collide the moment a
 * second server is configured, and it serializes `config` as JSON, which
 * cannot express the `!!js` expression that keeps the token out of the file.
 * @param server - the configured server.
 * @returns the row to insert.
 */
export function serverRow(server: McpServer): DeclaredPatchRow {
  return {
    id: serverRowId(server.id),
    name: MCP_CLIENT_PACKAGE,
    config: {
      serverName: server.id,
      transport: 'streamable-http',
      url: server.url,
      headers: {
        Authorization: jsExpression(`\`Bearer \${process.env.${serverEnvVar(server.id)}}\``),
      },
    },
  }
}

/**
 * Every row the enabled servers contribute to the overlay.
 * @param mcp - the `mcp` config section.
 * @returns one row per enabled server, or an empty list when MCP is off.
 */
export function serverRows(mcp: McpConfig | undefined): DeclaredPatchRow[] {
  return activeServers(mcp).map(serverRow)
}

/**
 * The environment additions carrying every enabled server's token to the
 * harness child.
 *
 * A server whose token is missing is still given its variable, empty: the
 * plugin then fails its own connection with the server's own `401`, which is
 * a clearer signal than a `!!js` expression resolving to `undefined` and
 * producing a header of the literal text `Bearer undefined`.
 * @param mcp - the `mcp` config section.
 * @param tokenFor - resolves one server's stored token by id.
 * @returns the variables to merge into the child's environment.
 */
export function serverEnv(
  mcp: McpConfig | undefined,
  tokenFor: (id: string) => string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const server of activeServers(mcp)) env[serverEnvVar(server.id)] = tokenFor(server.id) ?? ''
  return env
}

/**
 * The vendor's own name for a server's credential, for the settings window's
 * token field.
 * @param server - the configured server.
 * @returns the preset's `tokenLabel`, or a neutral default for a hand-added
 *   server or a preset id no longer shipped.
 */
export function tokenLabel(server: McpServer): string {
  return (server.preset === undefined ? undefined : findPreset(server.preset)?.tokenLabel) ?? 'Token'
}

/**
 * Validate a whole `mcp` section, whether it came from the settings form or
 * from a hand-edited `desktop.json`.
 * @param mcp - the section to check.
 * @returns the reasons it is unusable, empty when it is valid.
 */
export function mcpErrors(mcp: McpConfig): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const server of mcp.servers) {
    if (!validServerId(server.id)) {
      errors.push(`"${server.id}" is not a valid server name (letters, digits, - and _, up to 32 characters)`)
      continue
    }
    if (seen.has(server.id)) {
      errors.push(`"${server.id}" is listed more than once`)
      continue
    }
    seen.add(server.id)
    if (!validServerUrl(server.url)) errors.push(`"${server.id}" must have an https:// URL`)
  }
  return errors
}
