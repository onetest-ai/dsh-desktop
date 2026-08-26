import { jsExpression, type DeclaredPatchRow } from './bundle-patch'
import type { McpServerEntry } from './mcp-config'

/** The MCP client plugin one instance of which this app mounts per configured server. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * Shape of a valid server name: what is safe as a tool namespace, a YAML row
 * id, and an environment-variable stem at once.
 *
 * It matches the harness's own `serverName` rule (`[A-Za-z0-9_-]{1,32}`, see
 * `packages/mcp/mcp-client/README.md` in the deepseek-harness repo), so a
 * name this app accepts can never be rejected downstream by the plugin it
 * configures.
 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Whether a server name is usable everywhere it has to be.
 * @param name - the candidate name.
 * @returns whether it is safe to store and later expand.
 */
export function validServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name)
}

/**
 * Whether an HTTP server's URL is one this app will mount.
 *
 * Restricted to `https`, not merely to a parseable URL: a bearer token
 * travels to that URL, and `http` would put it on the wire in cleartext.
 * @param url - the candidate URL.
 * @returns whether it is an absolute https URL.
 */
export function validServerUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The overlay row id for one server.
 * @param name - the server name.
 * @returns the row id, namespaced so it can never collide with a plugin
 *   entry's own `insertId`-derived id.
 */
export function serverRowId(name: string): string {
  return `mcp-${name}`
}

/**
 * The environment-variable name carrying one server value to the harness child.
 *
 * The leading index is what makes the name unique: sanitizing a server name
 * and a key into one identifier can collide — server `a-b` key `c` and server
 * `a` key `b-c` both sanitize to `A_B_C` — and a collision would silently
 * hand one server another's credential. The sanitized suffix survives only so
 * the variable is recognizable while debugging.
 * @param index - the server's position in the generated list.
 * @param key - the env key or header name.
 * @returns the variable name, e.g. `DSH_MCP_0_API_KEY`.
 */
export function valueEnvVar(index: number, key: string): string {
  return `DSH_MCP_${String(index)}_${key.replaceAll(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

/**
 * The servers a boot should mount: every entry not disabled, and none at all
 * when the master switch is off.
 * @param servers - every configured entry.
 * @param enabled - the app-level master switch.
 * @returns the servers to mount, in configured order.
 */
export function activeServers(servers: McpServerEntry[], enabled: boolean): McpServerEntry[] {
  return enabled ? servers.filter((server) => !server.disabled) : []
}

/**
 * Replace every value in a map with a `!!js` lookup of the variable carrying
 * it, so the generated overlay names credentials instead of containing them.
 *
 * Applied to every value uniformly rather than to the ones that look secret:
 * the overlay is written world-readable while `mcp.json` is owner-only, and
 * which values are sensitive is not something this app can tell by name.
 * @param index - the server's position, for `valueEnvVar`.
 * @param values - the entry's `env` or `headers`.
 * @returns the same keys, each mapped to a deferred lookup.
 */
function deferValues(index: number, values: Record<string, string>): Record<string, object> {
  const deferred: Record<string, object> = {}
  for (const key of Object.keys(values)) {
    deferred[key] = jsExpression(`process.env.${valueEnvVar(index, key)}`)
  }
  return deferred
}

/**
 * One server's overlay row: an `@deepseek-ai/dsh-mcp-client` instance
 * configured to reach it.
 *
 * Emitted as a declared-patch row rather than through `patchOverlay`'s
 * synthesized-row path for two reasons that both matter: a synthesized row
 * takes its id from the package name, which would collide the moment a second
 * server is configured, and it serializes `config` as JSON, which cannot
 * express the `!!js` expressions that keep credentials out of the file.
 * @param server - the configured entry.
 * @param index - the server's position in the generated list.
 * @returns the row to insert.
 */
export function serverRow(server: McpServerEntry, index: number): DeclaredPatchRow {
  const config: Record<string, unknown> =
    server.transport === 'stdio'
      ? {
          serverName: server.name,
          transport: 'stdio',
          command: server.command,
          ...(server.args.length === 0 ? {} : { args: server.args }),
          ...(Object.keys(server.env).length === 0 ? {} : { env: deferValues(index, server.env) }),
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        }
      : {
          serverName: server.name,
          transport: 'streamable-http',
          url: server.url,
          ...(Object.keys(server.headers).length === 0 ? {} : { headers: deferValues(index, server.headers) }),
        }
  return { id: serverRowId(server.name), name: MCP_CLIENT_PACKAGE, config }
}

/**
 * Every row the active servers contribute to the overlay.
 * @param servers - every configured entry.
 * @param enabled - the app-level master switch.
 * @returns one row per active server.
 */
export function serverRows(servers: McpServerEntry[], enabled: boolean): DeclaredPatchRow[] {
  return activeServers(servers, enabled).map(serverRow)
}

/**
 * The environment additions carrying every active server's values to the
 * harness child.
 *
 * Walks the same list in the same order `serverRows` does, so the variables
 * it defines are exactly the ones the generated rows name.
 * @param servers - every configured entry.
 * @param enabled - the app-level master switch.
 * @returns the variables to merge into the child's environment.
 */
export function serverEnv(servers: McpServerEntry[], enabled: boolean): Record<string, string> {
  const env: Record<string, string> = {}
  activeServers(servers, enabled).forEach((server, index) => {
    const values = server.transport === 'stdio' ? server.env : server.headers
    for (const [key, value] of Object.entries(values)) env[valueEnvVar(index, key)] = value
  })
  return env
}

/**
 * Validate every configured server, whether it came from the settings window,
 * a pasted block, or a hand-edited `mcp.json`.
 * @param servers - the entries to check.
 * @returns the reasons they are unusable, empty when they are valid.
 */
export function mcpErrors(servers: McpServerEntry[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    if (!validServerName(server.name)) {
      errors.push(`"${server.name}" is not a valid server name (letters, digits, - and _, up to 32 characters)`)
      continue
    }
    if (seen.has(server.name)) {
      errors.push(`"${server.name}" is listed more than once`)
      continue
    }
    seen.add(server.name)
    if (server.transport === 'stdio') {
      if (server.command === undefined || server.command === '') errors.push(`"${server.name}" needs a command to run`)
    } else if (server.url === undefined || !validServerUrl(server.url)) {
      errors.push(`"${server.name}" must have an https:// URL`)
    }
  }
  return errors
}
