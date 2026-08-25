import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSecret, getSecret, hasSecret, reconcileSecrets, secretsPath, setSecret } from './secrets'

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
  it('round-trips a token', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'tvly-abc')
    expect(getSecret(file, 'tavily')).toBe('tvly-abc')
  })

  it('stores the token in the clear, which is the documented tradeoff', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'tvly-abc')
    expect(readFileSync(file, 'utf8')).toContain('tvly-abc')
  })

  it('writes the file owner-only, the only protection cleartext has', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'tvly-abc')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('restores owner-only mode on a file that already existed readable', () => {
    const file = freshFile()
    writeFileSync(file, '{}\n', { mode: 0o644 })
    setSecret(file, 'tavily', 'tvly-abc')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('stamps the format version, so a later format can tell itself apart', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'tvly-abc')
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })

  it('replaces a previous value for the same id', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'first')
    setSecret(file, 'tavily', 'second')
    expect(getSecret(file, 'tavily')).toBe('second')
  })

  it('keeps other ids untouched when one is written', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'one')
    setSecret(file, 'github', 'two')
    expect(getSecret(file, 'tavily')).toBe('one')
  })

  it('reads an absent id as undefined', () => {
    expect(getSecret(freshFile(), 'tavily')).toBeUndefined()
  })

  it('reads a malformed document as empty rather than throwing', () => {
    const file = freshFile()
    writeFileSync(file, 'not json at all')
    expect(getSecret(file, 'tavily')).toBeUndefined()
  })

  it('discards a document from the superseded encrypted format', () => {
    // The old format stored base64 ciphertext under the same `{id: string}`
    // shape. Read as a token it would be sent to a server as a bearer
    // credential, so an unversioned document is refused rather than guessed at.
    const file = freshFile()
    writeFileSync(file, JSON.stringify({ tavily: Buffer.from('enc:tvly-abc').toString('base64') }))
    expect(getSecret(file, 'tavily')).toBeUndefined()
    expect(hasSecret(file, 'tavily')).toBe(false)
  })

  it('discards a document claiming a version it does not understand', () => {
    const file = freshFile()
    writeFileSync(file, JSON.stringify({ version: 99, tokens: { tavily: 'tvly-abc' } }))
    expect(getSecret(file, 'tavily')).toBeUndefined()
  })

  it('recovers from a discarded document: the next write produces a readable one', () => {
    const file = freshFile()
    writeFileSync(file, JSON.stringify({ tavily: 'legacy-ciphertext' }))
    setSecret(file, 'tavily', 'tvly-new')
    expect(getSecret(file, 'tavily')).toBe('tvly-new')
  })
})

describe('hasSecret', () => {
  it('reports a stored token', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'tvly-abc')
    expect(hasSecret(file, 'tavily')).toBe(true)
  })

  it('reports an absent token', () => {
    expect(hasSecret(freshFile(), 'tavily')).toBe(false)
  })
})

describe('deleteSecret', () => {
  it('removes the named token', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'tvly-abc')
    deleteSecret(file, 'tavily')
    expect(hasSecret(file, 'tavily')).toBe(false)
  })

  it('leaves the other tokens in place', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'one')
    setSecret(file, 'github', 'two')
    deleteSecret(file, 'tavily')
    expect(getSecret(file, 'github')).toBe('two')
  })

  it('is a no-op for an absent id', () => {
    expect(() => deleteSecret(freshFile(), 'tavily')).not.toThrow()
  })
})

describe('reconcileSecrets', () => {
  it('drops a token whose server is gone', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'one')
    reconcileSecrets(file, new Set())
    expect(hasSecret(file, 'tavily')).toBe(false)
  })

  it('keeps the tokens still wanted', () => {
    const file = freshFile()
    setSecret(file, 'tavily', 'one')
    setSecret(file, 'github', 'two')
    reconcileSecrets(file, new Set(['github']))
    expect(getSecret(file, 'github')).toBe('two')
  })

  it('does not create a file when there is nothing to drop', () => {
    const file = freshFile()
    reconcileSecrets(file, new Set(['github']))
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })
})
