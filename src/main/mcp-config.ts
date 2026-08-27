import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './atomic-write'

/** Keys this app models; everything else on an entry is preserved in `rest`. */
const MODELLED_KEYS = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers', 'type', 'transport', 'disabled'])

/**
 * One configured MCP server, normalized out of the `mcpServers` format.
 *
 * `rest` carries every key this app does not model. A published block may
 * name fields belonging to other clients (`autoApprove`, `timeout`), and
 * dropping them on write would silently degrade a config the user pasted
 * from somewhere and may paste back.
 */
export interface McpServerEntry {
  name: string
  disabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  url?: string
  headers: Record<string, string>
  rest: Record<string, unknown>
}

/**
 * The configuration file, beside `desktop.json`.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute `mcp.json` path.
 */
export function mcpConfigPath(dshHome: string): string {
  return join(dshHome, 'mcp.json')
}

/**
 * Keep only the string-valued members of a candidate map.
 * @param value - the candidate, from untrusted JSON.
 * @returns the string entries, or an empty object.
 */
function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (typeof member === 'string') result[key] = member
  }
  return result
}

/**
 * Normalize one raw entry.
 *
 * Transport is inferred from `command` or `url` rather than taken from
 * `type`/`transport`: most published blocks omit that key entirely, so
 * trusting it would reject the majority of real configurations.
 * @param name - the entry's key in the `mcpServers` map.
 * @param raw - the entry's value.
 * @returns the normalized entry, or undefined when it names no transport.
 */
function normalize(name: string, raw: unknown): McpServerEntry | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  const command = typeof entry.command === 'string' && entry.command !== '' ? entry.command : undefined
  const url = typeof entry.url === 'string' && entry.url !== '' ? entry.url : undefined
  if (command === undefined && url === undefined) return undefined
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (!MODELLED_KEYS.has(key)) rest[key] = value
  }
  return {
    name,
    disabled: entry.disabled === true,
    transport: command !== undefined ? 'stdio' : 'http',
    ...(command === undefined ? {} : { command }),
    args: Array.isArray(entry.args) ? entry.args.filter((value): value is string => typeof value === 'string') : [],
    env: stringMap(entry.env),
    ...(typeof entry.cwd === 'string' && entry.cwd !== '' ? { cwd: entry.cwd } : {}),
    ...(url === undefined ? {} : { url }),
    headers: stringMap(entry.headers),
    rest,
  }
}

/**
 * Normalize a whole `mcpServers` map, skipping entries that name no transport.
 * @param servers - the raw map.
 * @returns the entries, in the order the document listed them.
 */
function normalizeAll(servers: Record<string, unknown>): McpServerEntry[] {
  const entries: McpServerEntry[] = []
  for (const [name, raw] of Object.entries(servers)) {
    const entry = normalize(name, raw)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/**
 * Read the configured servers.
 *
 * A missing, unreadable, or malformed file reads as no servers: this file is
 * hand-editable, and a typo in it must cost the user their MCP servers for
 * that boot, never the ability to start the app.
 * @param file - the `mcp.json` path.
 * @returns the configured entries.
 */
export function readMcpConfig(file: string): McpServerEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return []
  return normalizeAll(servers as Record<string, unknown>)
}

/**
 * Render one entry back to the published shape.
 *
 * Empty collections and absent optionals are omitted so the file stays close
 * to what a user pasted; `rest` is spread back so foreign keys survive.
 * @param entry - the entry to render.
 * @returns the JSON value for this server's key.
 */
function render(entry: McpServerEntry): Record<string, unknown> {
  return {
    ...entry.rest,
    ...(entry.command === undefined ? {} : { command: entry.command }),
    ...(entry.args.length === 0 ? {} : { args: entry.args }),
    ...(Object.keys(entry.env).length === 0 ? {} : { env: entry.env }),
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(entry.url === undefined ? {} : { type: 'http', url: entry.url }),
    ...(Object.keys(entry.headers).length === 0 ? {} : { headers: entry.headers }),
    ...(entry.disabled ? { disabled: true } : {}),
  }
}

/**
 * Write the configured servers.
 *
 * Owner-only: entries carry credentials in the clear, by design. The mode is
 * set again after the write because an already-existing file keeps its own.
 * @param file - the `mcp.json` path.
 * @param servers - the entries to persist, in display order.
 */
export function writeMcpConfig(file: string, servers: McpServerEntry[]): void {
  const mcpServers: Record<string, unknown> = {}
  for (const entry of servers) mcpServers[entry.name] = render(entry)
  // Atomic, and owner-only: the harness child reads this file at boot, and a
  // partial read there costs the user their MCP servers for that run.
  writeFileAtomic(file, `${JSON.stringify({ mcpServers }, undefined, 2)}\n`, 0o600)
}

/** A parsed paste, or the reason it was refused. */
export type BlockParse = { ok: true; servers: McpServerEntry[] } | { ok: false; message: string }

/**
 * Parse text pasted from a server's own documentation.
 *
 * Accepts both the wrapped `{"mcpServers": {…}}` form and a bare `{name: …}`
 * map, because READMEs publish both and a user pasting a fragment out of one
 * should not have to know which they copied.
 * @param text - the pasted text.
 * @returns the entries, or a message naming why nothing was taken.
 */
export function parseMcpBlock(text: string): BlockParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, message: `That is not valid JSON: ${(error as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: "Paste a JSON object, such as the mcpServers block from a server's README." }
  }
  const record = parsed as Record<string, unknown>
  const wrapped = record.mcpServers
  const source =
    wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : record
  const servers = normalizeAll(source)
  if (servers.length === 0) {
    return { ok: false, message: 'No server found. Each entry needs a "command" (stdio) or a "url" (HTTP).' }
  }
  return { ok: true, servers }
}
