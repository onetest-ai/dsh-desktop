import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpConfigPath, writeMcpConfig, type McpServerEntry } from './mcp-config'

/**
 * The shape MCP configuration had before `mcp.json`: a section inside
 * `desktop.json`, with tokens in a sibling `desktop-secrets.json`.
 *
 * Declared here rather than imported because nothing else in the app models
 * it any more — this module is the only remaining reader, and it exists to
 * make that true.
 */
interface LegacySection {
  enabled?: boolean
  servers?: { id?: string; preset?: string; url?: string; enabled?: boolean }[]
}

/**
 * Convert the superseded configuration into `mcp.json`, once.
 *
 * Refuses when `mcp.json` already exists: that file is the source of truth
 * afterwards, and overwriting it with a stale section would discard whatever
 * the user has configured since.
 *
 * A legacy server becomes an HTTP entry, its stored token becoming the
 * `Authorization` header it was always sent as. A server is written
 * `disabled` when either its own switch or the master switch was off, since
 * `mcp.json` has no separate master switch to carry that state.
 *
 * Never throws: a migration that cannot run leaves the old files in place,
 * and the app starts with no MCP servers rather than not at all.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns whether anything was migrated.
 */
export function migrateMcpConfig(dshHome: string): boolean {
  const target = mcpConfigPath(dshHome)
  if (existsSync(target)) return false

  const configFile = join(dshHome, 'desktop.json')
  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
  } catch {
    return false
  }
  const legacy = config.mcp as LegacySection | undefined
  if (legacy === undefined || !Array.isArray(legacy.servers)) return false

  const tokens = readLegacyTokens(join(dshHome, 'desktop-secrets.json'))
  const entries: McpServerEntry[] = []
  for (const server of legacy.servers) {
    if (typeof server?.id !== 'string' || typeof server.url !== 'string') continue
    const token = tokens[server.id]
    entries.push({
      name: server.id,
      disabled: legacy.enabled !== true || server.enabled !== true,
      transport: 'http',
      args: [],
      env: {},
      url: server.url,
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      rest: {},
    })
  }

  writeMcpConfig(target, entries)
  delete config.mcp
  writeFileSync(configFile, `${JSON.stringify(config, undefined, 2)}\n`)
  rmSync(join(dshHome, 'desktop-secrets.json'), { force: true })
  return true
}

/**
 * Read the superseded token store.
 *
 * Only the versioned cleartext format is read. The format before it held
 * base64 ciphertext under the same `{id: string}` shape, and a ciphertext
 * migrated as a token would be sent to a server as a bearer credential.
 * @param file - the `desktop-secrets.json` path.
 * @returns the stored tokens, or none.
 */
function readLegacyTokens(file: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const document = parsed as { version?: unknown; tokens?: unknown }
  if (document.version !== 1) return {}
  if (document.tokens === null || typeof document.tokens !== 'object' || Array.isArray(document.tokens)) return {}
  const tokens: Record<string, string> = {}
  for (const [id, value] of Object.entries(document.tokens as Record<string, unknown>)) {
    if (typeof value === 'string') tokens[id] = value
  }
  return tokens
}
