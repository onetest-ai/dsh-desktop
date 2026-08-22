import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formFor, validateSettings, type SettingsForm } from './settings-validate'

function form(overrides: Partial<SettingsForm> = {}): SettingsForm {
  return {
    kind: 'local',
    repo: mkdtempSync(join(tmpdir(), 'dsh-repo-')),
    package: '@deepseek-ai/dsh',
    version: 'latest',
    workspace: mkdtempSync(join(tmpdir(), 'dsh-ws-')),
    notifyPort: '43117',
    hotkey: 'CommandOrControl+Shift+D',
    pnpmPath: '',
    npmPath: '',
    ...overrides,
  }
}

describe('validateSettings — local source', () => {
  it('accepts a directory that exists', () => {
    const input = form()
    const result = validateSettings(input)
    expect(result).toEqual({
      ok: true,
      config: {
        harness: { kind: 'local', repo: input.repo },
        notifyPort: 43117,
        hotkey: 'CommandOrControl+Shift+D',
      },
    })
  })

  it('rejects an empty repo', () => {
    const result = validateSettings(form({ repo: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toMatch(/required/i)
  })

  it('rejects a repo that does not exist', () => {
    const result = validateSettings(form({ repo: '/definitely/not/here' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toMatch(/not a folder|does not exist/i)
  })

  it('rejects a repo that is a file rather than a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-file-'))
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    const result = validateSettings(form({ repo: file }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toMatch(/not a folder/i)
  })

  it('ignores managed fields when the source is local', () => {
    const result = validateSettings(form({ package: '', version: '', workspace: '' }))
    expect(result.ok).toBe(true)
  })
})

describe('validateSettings — managed source', () => {
  it('accepts a package and workspace', () => {
    const input = form({ kind: 'managed' })
    const result = validateSettings(input)
    expect(result).toEqual({
      ok: true,
      config: {
        harness: { kind: 'managed', package: '@deepseek-ai/dsh', version: 'latest', workspace: input.workspace },
        notifyPort: 43117,
        hotkey: 'CommandOrControl+Shift+D',
      },
    })
  })

  it('rejects an empty package', () => {
    const result = validateSettings(form({ kind: 'managed', package: '  ' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.package).toMatch(/required/i)
  })

  it('defaults an empty version to latest', () => {
    const result = validateSettings(form({ kind: 'managed', version: '' }))
    expect(result.ok).toBe(true)
    if (result.ok && result.config.harness.kind === 'managed') {
      expect(result.config.harness.version).toBe('latest')
    }
  })

  it('rejects a workspace that does not exist', () => {
    const result = validateSettings(form({ kind: 'managed', workspace: '/definitely/not/here' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.workspace).toMatch(/not a folder|does not exist/i)
  })

  it('ignores the repo field when the source is managed', () => {
    const result = validateSettings(form({ kind: 'managed', repo: '/definitely/not/here' }))
    expect(result.ok).toBe(true)
  })
})

describe('validateSettings — port and hotkey', () => {
  it.each(['0', '65536', '-1', 'abc', '', '80.5'])('rejects the port %s', (notifyPort) => {
    const result = validateSettings(form({ notifyPort }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.notifyPort).toBeDefined()
  })

  it('accepts a port at each end of the range', () => {
    expect(validateSettings(form({ notifyPort: '1' })).ok).toBe(true)
    expect(validateSettings(form({ notifyPort: '65535' })).ok).toBe(true)
  })

  it('rejects an empty hotkey', () => {
    const result = validateSettings(form({ hotkey: '   ' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.hotkey).toMatch(/required/i)
  })

  it('reports every bad field at once rather than stopping at the first', () => {
    const result = validateSettings(form({ repo: '', notifyPort: 'abc', hotkey: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['hotkey', 'notifyPort', 'repo'])
    }
  })

  it('omits blank binary paths rather than storing empty strings', () => {
    const result = validateSettings(form({ pnpmPath: '  ', npmPath: '' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect('pnpmPath' in result.config).toBe(false)
      expect('npmPath' in result.config).toBe(false)
    }
  })

  it('keeps binary paths that were provided', () => {
    const result = validateSettings(form({ pnpmPath: '/opt/pnpm' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.pnpmPath).toBe('/opt/pnpm')
  })
})

describe('formFor', () => {
  it('fills defaults for a first run', () => {
    const filled = formFor({ configured: false })
    expect(filled.kind).toBe('local')
    expect(filled.repo).toBe('')
    expect(filled.notifyPort).toBe('43117')
    expect(filled.hotkey).toBe('CommandOrControl+Shift+D')
    expect(filled.package).toBe('@deepseek-ai/dsh')
    expect(filled.version).toBe('latest')
  })

  it('round-trips a stored local config', () => {
    const config = {
      harness: { kind: 'local' as const, repo: '/tmp/harness' },
      notifyPort: 5000,
      hotkey: 'Alt+D',
    }
    const filled = formFor({ configured: true, config })
    expect(filled.repo).toBe('/tmp/harness')
    expect(filled.notifyPort).toBe('5000')
    expect(filled.hotkey).toBe('Alt+D')
  })

  it('round-trips a stored managed config', () => {
    const config = {
      harness: { kind: 'managed' as const, package: '@acme/dsh', version: '1.2.3', workspace: '/tmp/ws' },
      notifyPort: 43117,
      hotkey: 'Alt+D',
    }
    const filled = formFor({ configured: true, config })
    expect(filled.kind).toBe('managed')
    expect(filled.package).toBe('@acme/dsh')
    expect(filled.version).toBe('1.2.3')
    expect(filled.workspace).toBe('/tmp/ws')
  })
})
