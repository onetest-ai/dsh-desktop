import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCachedShellPath, resolveShellPath, shellPathCachePath, writeCachedShellPath } from './shell-path'

/** A fresh cache-file path that does not exist yet. */
function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-shellpath-')), 'shell-path.json')
}

describe('shellPathCachePath', () => {
  it('sits beside desktop.json rather than inside it', () => {
    expect(shellPathCachePath('/home/.dsh')).toBe('/home/.dsh/shell-path.json')
  })
})

describe('resolveShellPath', () => {
  it('returns the PATH the login shell reports', () => {
    const resolved = resolveShellPath('/bin/zsh', () => '/opt/homebrew/bin:/usr/bin\n')
    expect(resolved).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('asks an interactive login shell, the only mode that sources nvm', () => {
    let seen: string[] = []
    resolveShellPath('/bin/zsh', (_shell, args) => {
      seen = args
      return '/usr/bin\n'
    })
    expect(seen).toContain('-ilc')
  })

  it('uses the last line, since a chatty rc file may print first', () => {
    const resolved = resolveShellPath('/bin/zsh', () => 'welcome banner\n/opt/homebrew/bin:/usr/bin\n')
    expect(resolved).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('gives up when no shell is known rather than guessing one', () => {
    expect(resolveShellPath(undefined, () => '/usr/bin')).toBeUndefined()
  })

  it('gives up when the shell fails, so a broken rc file cannot break launch', () => {
    expect(
      resolveShellPath('/bin/zsh', () => {
        throw new Error('ETIMEDOUT')
      }),
    ).toBeUndefined()
  })

  it('rejects output that is not a PATH, rather than caching noise', () => {
    expect(resolveShellPath('/bin/zsh', () => 'command not found: nvm\n')).toBeUndefined()
  })

  it('rejects empty output', () => {
    expect(resolveShellPath('/bin/zsh', () => '   \n')).toBeUndefined()
  })
})

describe('writeCachedShellPath / readCachedShellPath', () => {
  it('round-trips a resolved PATH', () => {
    const file = freshFile()
    writeCachedShellPath(file, '/opt/homebrew/bin:/usr/bin', '/bin/zsh', '2026-08-25T00:00:00.000Z')
    expect(readCachedShellPath(file)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('records which shell produced it, so a changed shell is diagnosable', () => {
    const file = freshFile()
    writeCachedShellPath(file, '/usr/bin', '/bin/zsh', '2026-08-25T00:00:00.000Z')
    expect(JSON.parse(readFileSync(file, 'utf8')).shell).toBe('/bin/zsh')
  })

  it('writes owner-only: a PATH names directories worth not advertising', () => {
    const file = freshFile()
    writeCachedShellPath(file, '/usr/bin', '/bin/zsh', '2026-08-25T00:00:00.000Z')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reads an absent cache as undefined', () => {
    expect(readCachedShellPath(freshFile())).toBeUndefined()
  })

  it('reads a malformed cache as undefined rather than throwing', () => {
    const file = freshFile()
    writeFileSync(file, 'not json')
    expect(readCachedShellPath(file)).toBeUndefined()
  })

  it('discards a cache claiming a version it does not understand', () => {
    const file = freshFile()
    writeFileSync(file, JSON.stringify({ version: 99, path: '/usr/bin' }))
    expect(readCachedShellPath(file)).toBeUndefined()
  })
})
