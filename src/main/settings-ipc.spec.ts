import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsHandlers, type SettingsDeps } from './settings-ipc'
import type { SettingsForm } from './settings-validate'
import type { DesktopConfig } from './config'

const REPO = mkdtempSync(join(tmpdir(), 'dsh-repo-'))

function form(overrides: Partial<SettingsForm> = {}): SettingsForm {
  return {
    kind: 'local', repo: REPO, package: '@deepseek-ai/dsh', version: 'latest',
    workspace: '', notifyPort: '43117', hotkey: 'CommandOrControl+Shift+D',
    pnpmPath: '', npmPath: '', ...overrides,
  }
}

const STORED: DesktopConfig = {
  harness: { kind: 'local', repo: REPO },
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
})
