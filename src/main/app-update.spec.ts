import { describe, expect, it, vi } from 'vitest'
import { createAppUpdater, type UpdaterBackend } from './app-update'

/** A fake electron-updater backend: records config, lets tests emit events. */
function fakeBackend(): UpdaterBackend & { emit(event: string, arg?: unknown): void; checks: number; installs: number } {
  const handlers = new Map<string, (arg: unknown) => void>()
  return {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    checks: 0,
    installs: 0,
    on(event, cb) { handlers.set(event, cb as (arg: unknown) => void) },
    checkForUpdates() { this.checks += 1; return Promise.resolve(undefined) },
    quitAndInstall() { this.installs += 1 },
    emit(event, arg) { handlers.get(event)?.(arg) },
  }
}

describe('createAppUpdater', () => {
  it('sets autoDownload on and autoInstallOnAppQuit off when packaged', () => {
    const backend = fakeBackend()
    createAppUpdater({}, { packaged: true, backend })
    expect(backend.autoDownload).toBe(true)
    expect(backend.autoInstallOnAppQuit).toBe(false)
  })

  it('maps update-available to onAvailable(version)', () => {
    const backend = fakeBackend()
    const onAvailable = vi.fn()
    createAppUpdater({ onAvailable }, { packaged: true, backend })
    backend.emit('update-available', { version: '1.2.3' })
    expect(onAvailable).toHaveBeenCalledWith('1.2.3')
  })

  it('maps update-downloaded to onReady(version)', () => {
    const backend = fakeBackend()
    const onReady = vi.fn()
    createAppUpdater({ onReady }, { packaged: true, backend })
    backend.emit('update-downloaded', { version: '9.9.9' })
    expect(onReady).toHaveBeenCalledWith('9.9.9')
  })

  it('routes error to onError and never rethrows', () => {
    const backend = fakeBackend()
    const onError = vi.fn()
    createAppUpdater({ onError }, { packaged: true, backend })
    expect(() => backend.emit('error', new Error('offline'))).not.toThrow()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('checkNow delegates to the backend when packaged', () => {
    const backend = fakeBackend()
    const updater = createAppUpdater({}, { packaged: true, backend })
    updater.checkNow()
    expect(backend.checks).toBe(1)
  })

  it('quitAndInstall delegates to the backend when packaged', () => {
    const backend = fakeBackend()
    const updater = createAppUpdater({}, { packaged: true, backend })
    updater.quitAndInstall()
    expect(backend.installs).toBe(1)
  })

  it('is inert when not packaged: no listeners, checkNow is a no-op', () => {
    const backend = fakeBackend()
    const onAvailable = vi.fn()
    const updater = createAppUpdater({ onAvailable }, { packaged: false, backend })
    updater.checkNow()
    updater.quitAndInstall()
    expect(backend.checks).toBe(0)
    expect(backend.installs).toBe(0)
    backend.emit('update-available', { version: '1.0.0' })
    expect(onAvailable).not.toHaveBeenCalled()
  })

  it('a rejected checkForUpdates never surfaces as an unhandled rejection', async () => {
    const backend = fakeBackend()
    backend.checkForUpdates = () => Promise.reject(new Error('registry down'))
    const onError = vi.fn()
    const updater = createAppUpdater({ onError }, { packaged: true, backend })
    expect(() => updater.checkNow()).not.toThrow()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})
