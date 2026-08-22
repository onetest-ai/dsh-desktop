import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, writeConfig } from './config'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
}

function writeConfigFile(contents: string): string {
  const file = join(tempDir(), 'desktop.json')
  writeFileSync(file, contents)
  return file
}

describe('loadConfig', () => {
  it('reads a local harness source and applies defaults for the rest', () => {
    const file = writeConfigFile(JSON.stringify({ harness: { kind: 'local', repo: '/tmp/harness' } }))
    expect(loadConfig(file)).toEqual({
      configured: true,
      config: {
        harness: { kind: 'local', repo: '/tmp/harness' },
        notifyPort: 43117,
        hotkey: 'CommandOrControl+Shift+D',
      },
    })
  })

  it('reads a managed harness source', () => {
    const file = writeConfigFile(
      JSON.stringify({
        harness: { kind: 'managed', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
      }),
    )
    const result = loadConfig(file)
    expect(result.configured).toBe(true)
    expect(result.configured && result.config.harness).toEqual({
      kind: 'managed',
      package: '@deepseek-ai/dsh',
      version: 'latest',
      workspace: '/tmp/ws',
    })
  })

  it('keeps explicit overrides', () => {
    const file = writeConfigFile(
      JSON.stringify({
        harness: { kind: 'local', repo: '/tmp/h' },
        notifyPort: 5000,
        hotkey: 'Alt+D',
      }),
    )
    const result = loadConfig(file)
    expect(result.configured).toBe(true)
    expect(result.configured && result.config.notifyPort).toBe(5000)
    expect(result.configured && result.config.hotkey).toBe('Alt+D')
  })

  it('keeps an explicit npmPath alongside pnpmPath', () => {
    const file = writeConfigFile(
      JSON.stringify({
        harness: { kind: 'local', repo: '/tmp/h' },
        pnpmPath: '/opt/pnpm',
        npmPath: '/opt/npm',
      }),
    )
    const result = loadConfig(file)
    expect(result.configured).toBe(true)
    expect(result.configured && result.config.pnpmPath).toBe('/opt/pnpm')
    expect(result.configured && result.config.npmPath).toBe('/opt/npm')
  })

  it('throws a message naming the file when harness is missing', () => {
    const file = writeConfigFile(JSON.stringify({}))
    expect(() => loadConfig(file)).toThrow(/harness/)
    expect(() => loadConfig(file)).toThrow(file)
  })

  it('throws when harness.kind is neither local nor managed', () => {
    const file = writeConfigFile(JSON.stringify({ harness: { kind: 'ftp', repo: '/tmp/h' } }))
    expect(() => loadConfig(file)).toThrow(/harness\.kind must be "local" or "managed"/)
  })

  it('throws when a local harness has an empty repo', () => {
    const file = writeConfigFile(JSON.stringify({ harness: { kind: 'local', repo: '' } }))
    expect(() => loadConfig(file)).toThrow(/non-empty "repo"/)
  })

  it('throws when a managed harness has an empty package', () => {
    const file = writeConfigFile(
      JSON.stringify({ harness: { kind: 'managed', package: '', version: 'latest', workspace: '/tmp' } }),
    )
    expect(() => loadConfig(file)).toThrow(/non-empty "package"/)
  })

  it('throws a message naming the file when the JSON is malformed', () => {
    const file = writeConfigFile('{ not json')
    expect(() => loadConfig(file)).toThrow(file)
  })

  it('reports not-configured when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const file = join(dir, 'desktop.json')
    expect(loadConfig(file)).toEqual({ configured: false })
  })

  it('does not create a file when reporting not-configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const file = join(dir, 'desktop.json')
    loadConfig(file)
    expect(existsSync(file)).toBe(false)
  })

  it('still throws loudly on a read failure that is not ENOENT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const asDirectory = join(dir, 'desktop.json')
    mkdirSync(asDirectory)
    expect(() => loadConfig(asDirectory)).toThrow(/cannot read/)
    expect(statSync(asDirectory).isDirectory()).toBe(true)
  })

  it('returns the parsed config when the file exists', () => {
    const file = writeConfigFile(JSON.stringify({
      harness: { kind: 'local', repo: '/tmp/harness' },
    }))
    expect(loadConfig(file)).toEqual({
      configured: true,
      config: {
        harness: { kind: 'local', repo: '/tmp/harness' },
        notifyPort: 43117,
        hotkey: 'CommandOrControl+Shift+D',
      },
    })
  })

  it('writeConfig round-trips through loadConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const file = join(dir, 'nested', 'desktop.json')
    const config = {
      harness: { kind: 'managed' as const, package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
      notifyPort: 5000,
      hotkey: 'Alt+D',
    }
    writeConfig(file, config)
    expect(loadConfig(file)).toEqual({ configured: true, config })
  })

  describe('plugins', () => {
    it('accepts a well-shaped floating and pinned entry', () => {
      const file = writeConfigFile(
        JSON.stringify({
          harness: { kind: 'local', repo: '/tmp/harness' },
          plugins: [{ spec: '@onetest/dsh-deck' }, { spec: '@onetest/other@0.2.1', version: '0.2.1' }],
        }),
      )
      const result = loadConfig(file)
      expect(result.configured).toBe(true)
      expect(result.configured && result.config.plugins).toEqual([
        { spec: '@onetest/dsh-deck' },
        { spec: '@onetest/other@0.2.1', version: '0.2.1' },
      ])
    })

    it('rejects a hand-edited spec shaped like a path traversal', () => {
      // The Settings form can never produce this: `parsePluginsField`
      // rejects it before it is ever written. A hand-edited `desktop.json`
      // has no such gate, and an unvalidated spec here reaches
      // `packageDirIn`'s raw `join(..., ...pkg.split('/'))` and lands in the
      // generated overlay's import.
      const file = writeConfigFile(
        JSON.stringify({
          harness: { kind: 'local', repo: '/tmp/harness' },
          plugins: [{ spec: '../../etc' }],
        }),
      )
      expect(() => loadConfig(file)).toThrow(/plugin spec/)
    })

    it('rejects a hand-edited pinned entry with a traversal-shaped version', () => {
      const file = writeConfigFile(
        JSON.stringify({
          harness: { kind: 'local', repo: '/tmp/harness' },
          plugins: [{ spec: '@onetest/dsh-deck@../../etc' }],
        }),
      )
      expect(() => loadConfig(file)).toThrow(/plugin spec/)
    })
  })
})
