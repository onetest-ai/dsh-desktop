import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteSecret,
  getSecret,
  hasSecret,
  reconcileSecrets,
  secretsPath,
  SecretStoreUnavailableError,
  setSecret,
  type SecretCrypto,
} from './secrets'

/** A stand-in for Electron's `safeStorage`: reversible, and never real crypto. */
function fakeCrypto(available = true): SecretCrypto {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this key')
      return text.slice(4)
    },
  }
}

/** A fresh temp secrets file path that does not exist yet. */
function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-desktop-secrets-')), 'desktop-secrets.json')
}

describe('secretsPath', () => {
  it('sits beside desktop.json, not inside it', () => {
    expect(secretsPath('/home/.dsh')).toBe('/home/.dsh/desktop-secrets.json')
  })
})

describe('setSecret / getSecret', () => {
  it('round-trips a secret through the store', () => {
    const crypto = fakeCrypto()
    const file = freshFile()
    setSecret(crypto, file, 'tavily', 'tvly-abc')
    expect(getSecret(crypto, file, 'tavily')).toBe('tvly-abc')
  })

  it('never writes the secret itself to disk', () => {
    const file = freshFile()
    setSecret(fakeCrypto(), file, 'tavily', 'tvly-abc')
    expect(readFileSync(file, 'utf8')).not.toContain('tvly-abc')
  })

  it('writes the file owner-only', () => {
    const file = freshFile()
    setSecret(fakeCrypto(), file, 'tavily', 'tvly-abc')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('restores owner-only mode on a file that was created readable', () => {
    const file = freshFile()
    writeFileSync(file, '{}\n', { mode: 0o644 })
    setSecret(fakeCrypto(), file, 'tavily', 'tvly-abc')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('replaces a previous value for the same id', () => {
    const crypto = fakeCrypto()
    const file = freshFile()
    setSecret(crypto, file, 'tavily', 'first')
    setSecret(crypto, file, 'tavily', 'second')
    expect(getSecret(crypto, file, 'tavily')).toBe('second')
  })

  it('keeps other ids untouched when one is written', () => {
    const crypto = fakeCrypto()
    const file = freshFile()
    setSecret(crypto, file, 'tavily', 'one')
    setSecret(crypto, file, 'github', 'two')
    expect(getSecret(crypto, file, 'tavily')).toBe('one')
  })

  it('refuses to store anything when the platform has no secure store', () => {
    const file = freshFile()
    expect(() => setSecret(fakeCrypto(false), file, 'tavily', 'tvly-abc')).toThrow(SecretStoreUnavailableError)
  })

  it('leaves no file behind when it refuses', () => {
    const file = freshFile()
    try {
      setSecret(fakeCrypto(false), file, 'tavily', 'tvly-abc')
    } catch {
      // asserted by the test above; here only the absence of a write matters
    }
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('reads an absent id as undefined', () => {
    expect(getSecret(fakeCrypto(), freshFile(), 'tavily')).toBeUndefined()
  })

  it('reads a secret written under a different key as undefined rather than throwing', () => {
    const file = freshFile()
    writeFileSync(file, JSON.stringify({ tavily: Buffer.from('garbage').toString('base64') }))
    expect(getSecret(fakeCrypto(), file, 'tavily')).toBeUndefined()
  })

  it('reads a malformed document as empty rather than throwing', () => {
    const file = freshFile()
    writeFileSync(file, 'not json at all')
    expect(getSecret(fakeCrypto(), file, 'tavily')).toBeUndefined()
  })
})

describe('hasSecret', () => {
  it('reports a stored secret without needing the OS key', () => {
    const file = freshFile()
    setSecret(fakeCrypto(), file, 'tavily', 'tvly-abc')
    expect(hasSecret(file, 'tavily')).toBe(true)
  })

  it('reports an absent secret', () => {
    expect(hasSecret(freshFile(), 'tavily')).toBe(false)
  })
})

describe('deleteSecret', () => {
  it('removes the named secret', () => {
    const file = freshFile()
    setSecret(fakeCrypto(), file, 'tavily', 'tvly-abc')
    deleteSecret(file, 'tavily')
    expect(hasSecret(file, 'tavily')).toBe(false)
  })

  it('leaves the other secrets in place', () => {
    const crypto = fakeCrypto()
    const file = freshFile()
    setSecret(crypto, file, 'tavily', 'one')
    setSecret(crypto, file, 'github', 'two')
    deleteSecret(file, 'tavily')
    expect(getSecret(crypto, file, 'github')).toBe('two')
  })

  it('is a no-op for an absent id', () => {
    const file = freshFile()
    expect(() => deleteSecret(file, 'tavily')).not.toThrow()
  })
})

describe('reconcileSecrets', () => {
  it('drops a secret whose server is gone', () => {
    const file = freshFile()
    setSecret(fakeCrypto(), file, 'tavily', 'one')
    reconcileSecrets(file, new Set())
    expect(hasSecret(file, 'tavily')).toBe(false)
  })

  it('keeps the secrets still wanted', () => {
    const crypto = fakeCrypto()
    const file = freshFile()
    setSecret(crypto, file, 'tavily', 'one')
    setSecret(crypto, file, 'github', 'two')
    reconcileSecrets(file, new Set(['github']))
    expect(getSecret(crypto, file, 'github')).toBe('two')
  })

  it('does not create a file when there is nothing to drop', () => {
    const file = freshFile()
    reconcileSecrets(file, new Set(['github']))
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })
})
