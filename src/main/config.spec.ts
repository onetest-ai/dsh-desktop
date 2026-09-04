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

    it('accepts a well-shaped entry config', () => {
      const file = writeConfigFile(
        JSON.stringify({
          harness: { kind: 'local', repo: '/tmp/harness' },
          plugins: [{ spec: '@onetest/dsh-deck', config: { base: '/x' } }],
        }),
      )
      const result = loadConfig(file)
      expect(result.configured).toBe(true)
      expect(result.configured && result.config.plugins).toEqual([{ spec: '@onetest/dsh-deck', config: { base: '/x' } }])
    })

    it('rejects a hand-edited entry config that is an array', () => {
      const file = writeConfigFile(
        JSON.stringify({
          harness: { kind: 'local', repo: '/tmp/harness' },
          plugins: [{ spec: '@onetest/dsh-deck', config: [1, 2, 3] }],
        }),
      )
      expect(() => loadConfig(file)).toThrow(/config must be a JSON object/)
    })

    it('rejects a hand-edited entry config that is a bare string', () => {
      const file = writeConfigFile(
        JSON.stringify({
          harness: { kind: 'local', repo: '/tmp/harness' },
          plugins: [{ spec: '@onetest/dsh-deck', config: 'not-an-object' }],
        }),
      )
      expect(() => loadConfig(file)).toThrow(/config must be a JSON object/)
    })

    it('rejects a hand-edited entry config that is null', () => {
      const file = writeConfigFile(
        JSON.stringify({
          harness: { kind: 'local', repo: '/tmp/harness' },
          plugins: [{ spec: '@onetest/dsh-deck', config: null }],
        }),
      )
      expect(() => loadConfig(file)).toThrow(/config must be a JSON object/)
    })
  })
})

describe('extraPath', () => {
  it('is read back from the config', () => {
    const file = writeConfigFile(JSON.stringify({ harness: { kind: 'local', repo: '/tmp' }, extraPath: '/my/bin' }))
    const result = loadConfig(file)
    expect(result.configured && result.config.extraPath).toBe('/my/bin')
  })

  it('is optional, so a config predating it stays valid', () => {
    const file = writeConfigFile(JSON.stringify({ harness: { kind: 'local', repo: '/tmp' } }))
    const result = loadConfig(file)
    expect(result.configured && result.config.extraPath).toBeUndefined()
  })

  it('is rejected when it is not a string, since it reaches a spawned PATH', () => {
    const file = writeConfigFile(JSON.stringify({ harness: { kind: 'local', repo: '/tmp' }, extraPath: 42 }))
    expect(() => loadConfig(file)).toThrow(/extraPath/)
  })
})

describe('the stored pane state', () => {
  /** The stored config that results from a `desktop.json` with this `pane`. */
  const withPane = (pane: unknown): unknown => {
    const file = writeConfigFile(JSON.stringify({ harness: { kind: 'local', repo: '/tmp/harness' }, pane }))
    const result = loadConfig(file)
    return result.configured ? result.config.pane : undefined
  }

  it('keeps a usable width and open flag for each column', () => {
    const stored = { editor: { width: 560, open: true }, files: { width: 240, open: false, view: 'git' } }
    expect(withPane(stored)).toEqual(stored)
  })

  // reason: `view` was added with the git panel, so every config written by an
  // older build lacks it. Dropping the whole block over its absence would lose
  // the widths the user dragged; anything but `git` is the tree.
  it.each([
    ['a config from before the git panel', undefined],
    ['a view nobody wrote', 'source-control'],
    ['a view that is not a string', 3],
  ])('opens the side column on the tree given %s', (_case, view) => {
    const stored = { editor: { width: 560, open: true }, files: { width: 240, open: true, view } }
    expect(withPane(stored)).toEqual({
      editor: { width: 560, open: true },
      files: { width: 240, open: true, view: 'files' },
    })
  })

  // reason: this is window state the app writes for itself. Refusing to start
  // over a bad pane width would take away the window that fixes it.
  it.each([
    ['a missing block', undefined],
    ['a non-object', 7],
    ['an array', []],
    ['one column missing', { editor: { width: 560, open: true } }],
    ['a width that is not a number', { editor: { width: 'wide', open: true }, files: { width: 240, open: true } }],
    ['a negative width', { editor: { width: -10, open: true }, files: { width: 240, open: true } }],
    [
      'an infinite width',
      { editor: { width: Number.POSITIVE_INFINITY, open: true }, files: { width: 240, open: true } },
    ],
  ])('drops %s rather than throwing', (_case, pane) => {
    expect(withPane(pane)).toBeUndefined()
  })

  it('treats anything but true as closed', () => {
    const stored = { editor: { width: 560, open: 'yes' }, files: { width: 240, open: 1 } }
    expect(withPane(stored)).toEqual({
      editor: { width: 560, open: false },
      files: { width: 240, open: false, view: 'files' },
    })
  })
})

describe('writeConfig and a reader racing it', () => {
  // reason: this is the failure it exists to prevent. A plain write truncates
  // the target and then fills it, so a reader in that window gets a partial
  // file — which `loadConfig` rejects, which opens a Settings window that
  // looks unconfigured, which quits the app when closed.
  it('never leaves a state a reader would reject', () => {
    const file = join(tempDir(), 'desktop.json')
    const config = {
      harness: { kind: 'managed' as const, package: '@deepseek-ai/dsh', version: '0.1.0', workspace: '/tmp/ws' },
      notifyPort: 43117,
      hotkey: 'CommandOrControl+Shift+D',
    }
    writeConfig(file, config)
    // Rewritten repeatedly, reading back between every write: each read has to
    // land on one whole config or the other, never on nothing.
    for (let round = 0; round < 40; round += 1) {
      writeConfig(file, { ...config, notifyPort: 43117 + round })
      const result = loadConfig(file)
      expect(result.configured).toBe(true)
      expect(result.configured && result.config.harness.kind).toBe('managed')
    }
  })

  it('replaces the file rather than appending to it', () => {
    const file = join(tempDir(), 'desktop.json')
    writeConfig(file, {
      harness: { kind: 'local', repo: '/tmp/a' },
      notifyPort: 1,
      hotkey: 'CommandOrControl+Shift+D',
    })
    writeConfig(file, {
      harness: { kind: 'local', repo: '/tmp/b' },
      notifyPort: 2,
      hotkey: 'CommandOrControl+Shift+D',
    })
    const result = loadConfig(file)
    expect(result.configured && result.config.harness).toEqual({ kind: 'local', repo: '/tmp/b' })
  })
})

describe('terminalShell', () => {
  /**
   * Load a config with the given extra fields.
   * @param extra - fields merged over a minimal valid config.
   * @returns the loaded config.
   */
  function loadWith(extra: Record<string, unknown>): ReturnType<typeof loadConfig> {
    return loadConfig(
      writeConfigFile(JSON.stringify({ harness: { kind: 'local', repo: '/tmp/harness' }, ...extra })),
    )
  }

  it('is carried through when set', () => {
    expect(loadWith({ terminalShell: '/bin/bash' }).config).toMatchObject({ terminalShell: '/bin/bash' })
  })

  it('is absent when not set, which means the login shell', () => {
    expect(loadWith({}).config).not.toHaveProperty('terminalShell')
  })

  // reason: every other field fails loud on the wrong type, and a shell that
  // is a number would reach `pty.spawn` as one.
  it('refuses a value that is not a string', () => {
    expect(() => loadWith({ terminalShell: 42 })).toThrow(/terminalShell/)
  })
})
