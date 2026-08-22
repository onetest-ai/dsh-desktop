import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsHandlers, type SettingsDeps } from './settings-ipc'
import type { SettingsForm } from './settings-validate'
import type { DesktopConfig } from './config'

const REPO = mkdtempSync(join(tmpdir(), 'dsh-repo-'))
const PKG = '@deepseek-ai/dsh'

function form(overrides: Partial<SettingsForm> = {}): SettingsForm {
  return {
    kind: 'local', repo: REPO, package: PKG, version: 'latest',
    workspace: '', notifyPort: '43117', hotkey: 'CommandOrControl+Shift+D',
    pnpmPath: '', npmPath: '', ...overrides,
  }
}

const STORED: DesktopConfig = {
  harness: { kind: 'local', repo: REPO },
  notifyPort: 43117,
  hotkey: 'CommandOrControl+Shift+D',
}

const MANAGED_STORED: DesktopConfig = {
  harness: { kind: 'managed', package: PKG, version: '0.1.1-rc.2', workspace: REPO },
  notifyPort: 43117,
  hotkey: 'CommandOrControl+Shift+D',
}

function deps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    readConfig: () => ({ configured: true, config: STORED }),
    writeConfig: vi.fn(),
    pickFolder: vi.fn(async () => '/picked'),
    probePort: vi.fn(async () => true),
    apply: vi.fn(async () => []),
    isQuitting: () => false,
    installManaged: vi.fn(async (_pkg, version) => version),
    checkManagedUpdate: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('read', () => {
  it('returns the stored values as form fields', () => {
    expect(createSettingsHandlers(deps()).read()).toEqual({
      configured: true,
      form: expect.objectContaining({ kind: 'local', repo: REPO, notifyPort: '43117' }),
    })
  })

  it('returns defaults on a first run', () => {
    const handlers = createSettingsHandlers(deps({ readConfig: () => ({ configured: false }) }))
    expect(handlers.read()).toEqual({
      configured: false,
      form: expect.objectContaining({ repo: '', notifyPort: '43117' }),
    })
  })

  it('reports an available update for a managed source, out of band', async () => {
    const checkManagedUpdate = vi.fn(async () => '0.2.0')
    const d = deps({ readConfig: () => ({ configured: true, config: MANAGED_STORED }), checkManagedUpdate })
    const onUpdateAvailable = vi.fn()

    createSettingsHandlers(d).read(onUpdateAvailable)
    await Promise.resolve()
    await Promise.resolve()

    expect(checkManagedUpdate).toHaveBeenCalledWith(PKG, '0.1.1-rc.2', undefined)
    expect(onUpdateAvailable).toHaveBeenCalledWith('0.2.0')
  })

  it('stays silent when the update lookup fails, rather than surfacing an error', async () => {
    // Non-vacuity: with the `.catch` in `read` removed, this test's rejected
    // `checkManagedUpdate` promise becomes an unhandled rejection and the test
    // fails instead of passing quietly. Restoring the catch fixes it.
    const checkManagedUpdate = vi.fn(async () => {
      throw new Error('registry unreachable')
    })
    const d = deps({ readConfig: () => ({ configured: true, config: MANAGED_STORED }), checkManagedUpdate })
    const onUpdateAvailable = vi.fn()

    createSettingsHandlers(d).read(onUpdateAvailable)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(onUpdateAvailable).not.toHaveBeenCalled()
  })

  it('never checks for an update on a local source', () => {
    const checkManagedUpdate = vi.fn(async () => '0.2.0')
    const d = deps({ checkManagedUpdate })
    createSettingsHandlers(d).read(vi.fn())
    expect(checkManagedUpdate).not.toHaveBeenCalled()
  })
})

describe('pickFolder', () => {
  it('returns the chosen path', async () => {
    await expect(createSettingsHandlers(deps()).pickFolder()).resolves.toBe('/picked')
  })

  it('returns undefined when cancelled', async () => {
    const handlers = createSettingsHandlers(deps({ pickFolder: async () => undefined }))
    await expect(handlers.pickFolder()).resolves.toBeUndefined()
  })
})

describe('save', () => {
  it('writes and applies a valid form', async () => {
    const d = deps()
    const result = await createSettingsHandlers(d).save(form())
    expect(result).toEqual({ ok: true, warnings: [] })
    expect(d.writeConfig).toHaveBeenCalledWith({
      harness: { kind: 'local', repo: REPO },
      notifyPort: 43117,
      hotkey: 'CommandOrControl+Shift+D',
    })
    expect(d.apply).toHaveBeenCalledWith(STORED, expect.objectContaining({ notifyPort: 43117 }))
  })

  it('returns field errors and writes nothing when invalid', async () => {
    const d = deps()
    const result = await createSettingsHandlers(d).save(form({ repo: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toBeDefined()
    expect(d.writeConfig).not.toHaveBeenCalled()
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('rejects a port that is already bound, naming it', async () => {
    const d = deps({ probePort: async () => false })
    const result = await createSettingsHandlers(d).save(form({ notifyPort: '5000' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.notifyPort).toContain('5000')
    expect(d.writeConfig).not.toHaveBeenCalled()
  })

  it('does not probe a port that is unchanged', async () => {
    const d = deps()
    await createSettingsHandlers(d).save(form())
    expect(d.probePort).not.toHaveBeenCalled()
  })

  it('probes only when the port actually changes', async () => {
    const d = deps()
    await createSettingsHandlers(d).save(form({ notifyPort: '5000' }))
    expect(d.probePort).toHaveBeenCalledWith(5000)
  })

  it('refuses to save while the app is quitting', async () => {
    const d = deps({ isQuitting: () => true })
    const result = await createSettingsHandlers(d).save(form())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.kind).toMatch(/quitting|shutting down/i)
    expect(d.writeConfig).not.toHaveBeenCalled()
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('passes undefined as previous on a first run', async () => {
    const d = deps({ readConfig: () => ({ configured: false }) })
    await createSettingsHandlers(d).save(form())
    expect(d.apply).toHaveBeenCalledWith(undefined, expect.anything())
  })

  it('does not apply when writing fails', async () => {
    const d = deps({ writeConfig: vi.fn(() => { throw new Error('disk full') }) })
    await expect(createSettingsHandlers(d).save(form())).rejects.toThrow(/disk full/)
    expect(d.apply).not.toHaveBeenCalled()
  })

  describe('a managed source', () => {
    it('resolves and installs, storing the concrete version rather than the submitted tag', async () => {
      const installManaged = vi.fn(async () => '0.1.1-rc.2')
      const d = deps({ installManaged })
      const result = await createSettingsHandlers(d).save(form({ kind: 'managed', version: 'latest', workspace: REPO }))

      expect(result).toEqual({ ok: true, warnings: [] })
      expect(installManaged).toHaveBeenCalledWith(PKG, 'latest', undefined, expect.any(Function))
      expect(d.writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ harness: { kind: 'managed', package: PKG, version: '0.1.1-rc.2', workspace: REPO } }),
      )
    })

    it('streams install progress through onProgress', async () => {
      const installManaged = vi.fn(async (_pkg: string, _version: string, _npmPath: string | undefined, onLine: (line: string) => void) => {
        onLine('added 455 packages')
        return '0.1.1-rc.2'
      })
      const d = deps({ installManaged })
      const progress: string[] = []

      await createSettingsHandlers(d).save(form({ kind: 'managed' }), (line) => progress.push(line))

      expect(progress).toEqual(['added 455 packages'])
    })

    it('rejects the save when install fails, without writing', async () => {
      const installManaged = vi.fn(async () => {
        throw new Error('npm install failed: network timeout')
      })
      const d = deps({ installManaged })
      const result = await createSettingsHandlers(d).save(form({ kind: 'managed' }))

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.version).toContain('network timeout')
      expect(d.writeConfig).not.toHaveBeenCalled()
      expect(d.apply).not.toHaveBeenCalled()
    })

    it('refuses to write when quitting arrives during a long install, even though the save started before it', async () => {
      let quitting = false
      const installManaged = vi.fn(async () => {
        // The install "completes" only after a quit lands mid-flight.
        quitting = true
        return '0.1.1-rc.2'
      })
      const d = deps({ installManaged, isQuitting: () => quitting })
      const result = await createSettingsHandlers(d).save(form({ kind: 'managed' }))

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.kind).toMatch(/quitting|shutting down/i)
      expect(d.writeConfig).not.toHaveBeenCalled()
      expect(d.apply).not.toHaveBeenCalled()
    })
  })
})
