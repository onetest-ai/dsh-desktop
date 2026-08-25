import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The file MCP server tokens are stored in, beside `desktop.json`.
 *
 * A separate file rather than a field in `desktop.json`: that file is
 * hand-editable and its "Open config file…" button puts it in front of the
 * user, and rewriting the whole config to change one token would couple the
 * two lifetimes.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute secrets-file path.
 */
export function secretsPath(dshHome: string): string {
  return join(dshHome, 'desktop-secrets.json')
}

/**
 * The on-disk document.
 *
 * Tokens are stored in the clear, deliberately, matching what `.mcp.json`,
 * `~/.aws/credentials`, `~/.npmrc`, and the `gh` CLI do. The alternative —
 * Electron's `safeStorage`, backed by the OS keychain — was tried and
 * removed: a Keychain item's ACL trusts specific signed binaries, so every
 * re-signed build, every bundle-id change, and every separate copy of the app
 * raises its own password prompt. A first-run experience that asks an
 * ordinary user for their login password several times is worse than the
 * threat it defends against, for a developer tool whose agent already runs
 * shell commands as that user.
 *
 * What the clear text does NOT defend against: any process running as this
 * user can read these tokens, and they are captured by Time Machine and any
 * file-syncing backup. File permissions (`0600`) keep out other accounts on
 * the machine, and nothing more.
 *
 * `version` exists because the format this replaced stored base64 ciphertext
 * under the same `{id: string}` shape. Without a marker the two are
 * indistinguishable, and a leftover encrypted value would be read as a token
 * and sent to a server as a bearer credential. A document without the marker
 * is discarded rather than guessed at.
 */
interface SecretDocument {
  version: 1
  tokens: Record<string, string>
}

/** The only format this version understands; see `SecretDocument.version`. */
const CURRENT_VERSION = 1

/**
 * Read the stored tokens.
 *
 * A missing, unreadable, or malformed file reads as empty rather than
 * throwing: a secrets file this app cannot parse must never keep it from
 * starting, and every consumer already handles a token being absent. A
 * document from the superseded encrypted format is discarded the same way,
 * so its ciphertext is never mistaken for a token.
 * @param file - the secrets-file path.
 * @returns the stored id-to-token map, or an empty one.
 */
function readTokens(file: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const document = parsed as Partial<SecretDocument>
  if (document.version !== CURRENT_VERSION) return {}
  if (document.tokens === null || typeof document.tokens !== 'object' || Array.isArray(document.tokens)) return {}
  const tokens: Record<string, string> = {}
  for (const [id, value] of Object.entries(document.tokens)) {
    if (typeof value === 'string') tokens[id] = value
  }
  return tokens
}

/**
 * Write the tokens owner-only.
 *
 * The mode is set explicitly after the write as well as requested on it: an
 * already-existing file keeps its own mode through `writeFileSync`, so a file
 * that was somehow created world-readable would otherwise stay that way. With
 * the contents in the clear, this permission is the only protection the file
 * has.
 * @param file - the secrets-file path.
 * @param tokens - the id-to-token map to persist.
 */
function writeTokens(file: string, tokens: Record<string, string>): void {
  const document: SecretDocument = { version: CURRENT_VERSION, tokens }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/**
 * Store one token, replacing any previous value for the same id.
 * @param file - the secrets-file path.
 * @param id - the server id.
 * @param value - the token.
 */
export function setSecret(file: string, id: string, value: string): void {
  const tokens = readTokens(file)
  tokens[id] = value
  writeTokens(file, tokens)
}

/**
 * Read one token back.
 * @param file - the secrets-file path.
 * @param id - the server id.
 * @returns the token, or undefined when none is stored.
 */
export function getSecret(file: string, id: string): string | undefined {
  return readTokens(file)[id]
}

/**
 * Whether a token is stored for an id.
 * @param file - the secrets-file path.
 * @param id - the server id.
 * @returns whether a token is stored under that id.
 */
export function hasSecret(file: string, id: string): boolean {
  return readTokens(file)[id] !== undefined
}

/**
 * Remove one token. Removing an absent id is a no-op.
 * @param file - the secrets-file path.
 * @param id - the server id.
 */
export function deleteSecret(file: string, id: string): void {
  const tokens = readTokens(file)
  if (tokens[id] === undefined) return
  delete tokens[id]
  writeTokens(file, tokens)
}

/**
 * Drop every stored token whose id is no longer wanted.
 *
 * Called after a save so a removed server's token does not outlive the server
 * it belonged to; one left behind would silently come back if an id were ever
 * reused.
 * @param file - the secrets-file path.
 * @param keep - the ids that should survive.
 */
export function reconcileSecrets(file: string, keep: ReadonlySet<string>): void {
  const tokens = readTokens(file)
  const stale = Object.keys(tokens).filter((id) => !keep.has(id))
  if (stale.length === 0) return
  for (const id of stale) delete tokens[id]
  writeTokens(file, tokens)
}
