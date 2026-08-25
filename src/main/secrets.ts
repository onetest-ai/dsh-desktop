import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The OS-backed encryption this store writes through — Electron's
 * `safeStorage`, narrowed to the three methods used here so tests can supply
 * their own and so nothing else in the app depends on Electron's shape.
 *
 * `safeStorage` is already the per-platform abstraction: it encrypts through
 * the Keychain on macOS, DPAPI on Windows, and libsecret/kwallet on Linux,
 * choosing the backend itself. This app deliberately does not add a second
 * layer of platform selection over it.
 */
export interface SecretCrypto {
  /**
   * Whether a real OS-backed key is available for this session.
   * @returns false when the platform has no usable secure store.
   */
  isEncryptionAvailable(): boolean
  /**
   * Encrypt one secret with the OS-backed key.
   * @param plainText - the secret.
   * @returns the ciphertext.
   */
  encryptString(plainText: string): Buffer
  /**
   * Decrypt one previously encrypted secret.
   * @param encrypted - ciphertext produced by `encryptString` on this machine.
   * @returns the secret.
   */
  decryptString(encrypted: Buffer): string
}

/**
 * Raised when a secret cannot be stored because this machine has no OS-backed
 * secure store. Distinguished from an ordinary write failure because the
 * caller's response differs: there is nothing to retry, and the user has to
 * be told their desktop environment cannot hold the secret at all.
 */
export class SecretStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretStoreUnavailableError'
  }
}

/**
 * The file secrets are stored in, beside `desktop.json`.
 *
 * A separate file rather than a field in `desktop.json`: that file is
 * hand-editable and its "Open config file…" button puts it in front of the
 * user, which is the wrong place for ciphertext, and rewriting the whole
 * config to change one token would couple the two lifetimes.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute secrets-file path.
 */
export function secretsPath(dshHome: string): string {
  return join(dshHome, 'desktop-secrets.json')
}

/** The on-disk document: secret id to base64 ciphertext. */
type SecretDocument = Record<string, string>

/**
 * Read the stored document.
 *
 * A missing, unreadable, or malformed file reads as empty rather than
 * throwing: a secrets file this app cannot parse must never keep the app
 * from starting, and every consumer already handles a secret being absent.
 * The cost of the lenient read is that a corrupted file is replaced on the
 * next write instead of being reported — acceptable for a store whose whole
 * contents the user can re-enter.
 * @param file - the secrets-file path.
 * @returns the stored id-to-ciphertext map, or an empty one.
 */
function readDocument(file: string): SecretDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const document: SecretDocument = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') document[id] = value
  }
  return document
}

/**
 * Write the document owner-only.
 *
 * The mode is set explicitly after the write as well as requested on it,
 * because an already-existing file keeps its own mode through `writeFileSync`
 * — a file that was somehow created world-readable would otherwise stay that
 * way for every subsequent write.
 * @param file - the secrets-file path.
 * @param document - the id-to-ciphertext map to persist.
 */
function writeDocument(file: string, document: SecretDocument): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/**
 * Store one secret, replacing any previous value for the same id.
 * @param crypto - the OS-backed encryption to write through.
 * @param file - the secrets-file path.
 * @param id - the secret's id.
 * @param value - the secret.
 * @throws SecretStoreUnavailableError when this machine has no secure store —
 *   the secret is not written anywhere, in cleartext or otherwise.
 */
export function setSecret(crypto: SecretCrypto, file: string, id: string, value: string): void {
  if (!crypto.isEncryptionAvailable()) {
    throw new SecretStoreUnavailableError(
      'this desktop environment has no secure credential store, so the token cannot be saved',
    )
  }
  const document = readDocument(file)
  document[id] = crypto.encryptString(value).toString('base64')
  writeDocument(file, document)
}

/**
 * Read one secret back.
 *
 * A secret that cannot be decrypted — written under a different OS key, or
 * corrupted — reads as absent rather than throwing, so one unreadable entry
 * cannot keep the others from being used.
 * @param crypto - the OS-backed encryption to read through.
 * @param file - the secrets-file path.
 * @param id - the secret's id.
 * @returns the secret, or undefined when it is absent or undecryptable.
 */
export function getSecret(crypto: SecretCrypto, file: string, id: string): string | undefined {
  const stored = readDocument(file)[id]
  if (stored === undefined) return undefined
  if (!crypto.isEncryptionAvailable()) return undefined
  try {
    return crypto.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return undefined
  }
}

/**
 * Whether a secret is stored for an id, without decrypting it.
 *
 * This is what the settings window asks: it shows whether a token is on file
 * and never displays the token itself, so it must not need the OS key.
 * @param file - the secrets-file path.
 * @param id - the secret's id.
 * @returns whether ciphertext is stored under that id.
 */
export function hasSecret(file: string, id: string): boolean {
  return readDocument(file)[id] !== undefined
}

/**
 * Remove one secret. Removing an absent id is a no-op.
 * @param file - the secrets-file path.
 * @param id - the secret's id.
 */
export function deleteSecret(file: string, id: string): void {
  const document = readDocument(file)
  if (document[id] === undefined) return
  delete document[id]
  writeDocument(file, document)
}

/**
 * Drop every stored secret whose id is no longer wanted.
 *
 * Called after a save so a removed server's token does not outlive the server
 * it belonged to; a token left behind would silently come back if an id were
 * ever reused.
 * @param file - the secrets-file path.
 * @param keep - the ids that should survive.
 */
export function reconcileSecrets(file: string, keep: ReadonlySet<string>): void {
  const document = readDocument(file)
  const stale = Object.keys(document).filter((id) => !keep.has(id))
  if (stale.length === 0) return
  for (const id of stale) delete document[id]
  writeDocument(file, document)
}
