import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
}

function writeConfig(contents: string): string {
  const file = join(tempDir(), 'desktop.json')
  writeFileSync(file, contents)
  return file
}

describe('loadConfig', () => {
  it('reads a local harness source and applies defaults for the rest', () => {
    const file = writeConfig(JSON.stringify({ harness: { kind: 'local', repo: '/tmp/harness' } }))
    expect(loadConfig(file, '/unused')).toEqual({
      harness: { kind: 'local', repo: '/tmp/harness' },
      notifyPort: 43117,
      hotkey: 'CommandOrControl+Shift+D',
    })
  })

  it('reads an npx harness source', () => {
    const file = writeConfig(
      JSON.stringify({
        harness: { kind: 'npx', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
      }),
    )
    expect(loadConfig(file, '/unused').harness).toEqual({
      kind: 'npx',
      package: '@deepseek-ai/dsh',
      version: 'latest',
      workspace: '/tmp/ws',
    })
  })

  it('keeps explicit overrides', () => {
    const file = writeConfig(
      JSON.stringify({
        harness: { kind: 'local', repo: '/tmp/h' },
        notifyPort: 5000,
        hotkey: 'Alt+D',
      }),
    )
    const config = loadConfig(file, '/unused')
    expect(config.notifyPort).toBe(5000)
    expect(config.hotkey).toBe('Alt+D')
  })

  it('keeps an explicit npxPath alongside pnpmPath', () => {
    const file = writeConfig(
      JSON.stringify({
        harness: { kind: 'local', repo: '/tmp/h' },
        pnpmPath: '/opt/pnpm',
        npxPath: '/opt/npx',
      }),
    )
    const config = loadConfig(file, '/unused')
    expect(config.pnpmPath).toBe('/opt/pnpm')
    expect(config.npxPath).toBe('/opt/npx')
  })

  it('throws a message naming the file when harness is missing', () => {
    const file = writeConfig(JSON.stringify({}))
    expect(() => loadConfig(file, '/unused')).toThrow(/harness/)
    expect(() => loadConfig(file, '/unused')).toThrow(file)
  })

  it('throws when harness.kind is neither local nor npx', () => {
    const file = writeConfig(JSON.stringify({ harness: { kind: 'ftp', repo: '/tmp/h' } }))
    expect(() => loadConfig(file, '/unused')).toThrow(/harness\.kind must be "local" or "npx"/)
  })

  it('throws when a local harness has an empty repo', () => {
    const file = writeConfig(JSON.stringify({ harness: { kind: 'local', repo: '' } }))
    expect(() => loadConfig(file, '/unused')).toThrow(/non-empty "repo"/)
  })

  it('throws when an npx harness has an empty package', () => {
    const file = writeConfig(
      JSON.stringify({ harness: { kind: 'npx', package: '', version: 'latest', workspace: '/tmp' } }),
    )
    expect(() => loadConfig(file, '/unused')).toThrow(/non-empty "package"/)
  })

  it('throws a message naming the file when the JSON is malformed', () => {
    const file = writeConfig('{ not json')
    expect(() => loadConfig(file, '/unused')).toThrow(file)
  })

  it('seeds a default config pointing at the candidate repo when the file is absent', () => {
    const dir = tempDir()
    const file = join(dir, 'desktop.json')
    expect(existsSync(file)).toBe(false)

    const config = loadConfig(file, process.cwd())

    expect(config.harness).toEqual({ kind: 'local', repo: process.cwd() })
    expect(config.notifyPort).toBe(43117)
    expect(config.hotkey).toBe('CommandOrControl+Shift+D')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(config)
  })

  it('seeds an npx default when the candidate repo does not exist', () => {
    const dir = tempDir()
    const file = join(dir, 'desktop.json')

    const config = loadConfig(file, '/definitely/not/here')

    expect(config.harness.kind).toBe('npx')
    expect(existsSync(file)).toBe(true)
  })

  it('creates missing parent directories when seeding', () => {
    const dir = tempDir()
    const file = join(dir, 'nested', 'deeper', 'desktop.json')

    const config = loadConfig(file, process.cwd())

    expect(existsSync(file)).toBe(true)
    expect(config.harness).toEqual({ kind: 'local', repo: process.cwd() })
  })
})
