import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsHandlers } from './settings-ipc'

/**
 * `settings-window.ts` wires the settings IPC channels to a real
 * `BrowserWindow`; these tests drive it through a faked `electron` module the
 * same way `index.spec.ts` does, so the push channels are exercised without a
 * real window.
 */

const fake = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const sent: Array<{ channel: string; payload: unknown }> = []
  const destroyedFlag = { value: false }

  const webContents = { send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })) }
  const windowInstance = {
    webContents,
    isDestroyed: () => destroyedFlag.value,
    loadFile: vi.fn(async () => {}),
    on: vi.fn(),
    focus: vi.fn(),
  }

  return {
    ipcHandlers,
    sent,
    windowInstance,
    destroyedFlag,
    destroy: () => {
      destroyedFlag.value = true
    },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler)
      },
    },
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      return fake.windowInstance as unknown as InstanceType<typeof import('electron').BrowserWindow>
    }
  },
  ipcMain: fake.ipcMain,
}))

function handlers(overrides: Partial<SettingsHandlers> = {}): SettingsHandlers {
  return {
    read: vi.fn(() => ({ configured: true, form: {} as never })),
    pickFolder: vi.fn(async () => undefined),
    save: vi.fn(async () => ({ ok: true, warnings: [] })),
    ...overrides,
  }
}

beforeEach(() => {
  fake.sent.length = 0
  fake.ipcHandlers.clear()
  fake.destroyedFlag.value = false
  vi.resetModules()
})

describe('the save channel', () => {
  it('forwards each installed progress line to the window over settings:progress', async () => {
    const { openSettings } = await import('./settings-window')
    const save = vi.fn(async (_form: unknown, onProgress?: (line: string) => void) => {
      onProgress?.('added 455 packages')
      onProgress?.('found 0 vulnerabilities')
      return { ok: true, warnings: [] }
    })
    openSettings(handlers({ save }), () => {})

    const saveHandler = fake.ipcHandlers.get('settings:save')
    await saveHandler?.({}, {})

    expect(fake.sent).toEqual([
      { channel: 'settings:progress', payload: 'added 455 packages' },
      { channel: 'settings:progress', payload: 'found 0 vulnerabilities' },
    ])
  })

  it('never sends once the window has been destroyed', async () => {
    const { openSettings } = await import('./settings-window')
    let capturedOnProgress: ((line: string) => void) | undefined
    const save = vi.fn(async (_form: unknown, onProgress?: (line: string) => void) => {
      capturedOnProgress = onProgress
      return { ok: true, warnings: [] }
    })
    openSettings(handlers({ save }), () => {})

    const saveHandler = fake.ipcHandlers.get('settings:save')
    await saveHandler?.({}, {})
    fake.destroy()
    capturedOnProgress?.('a line after the window closed')

    expect(fake.sent.find((entry) => entry.payload === 'a line after the window closed')).toBeUndefined()
  })
})

describe('the read channel', () => {
  it('forwards a later update-available result over settings:update-available', async () => {
    const { openSettings } = await import('./settings-window')
    let capturedOnUpdate: ((latest: string) => void) | undefined
    const read = vi.fn((onUpdateAvailable?: (latest: string) => void) => {
      capturedOnUpdate = onUpdateAvailable
      return { configured: true, form: {} as never }
    })
    openSettings(handlers({ read }), () => {})

    const readHandler = fake.ipcHandlers.get('settings:read')
    readHandler?.({})
    capturedOnUpdate?.('0.2.0')

    expect(fake.sent).toEqual([{ channel: 'settings:update-available', payload: '0.2.0' }])
  })
})
