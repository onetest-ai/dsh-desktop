import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsHandlers } from './settings-ipc'

/**
 * `settings-window.ts` wires the settings IPC channels to a real
 * `BrowserWindow`; these tests drive it through a faked `electron` module the
 * same way `index.spec.ts` does, so the push channels are exercised without a
 * real window.
 */

interface FakeSender {
  name: string
  destroyed: boolean
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

const fake = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const sent: Array<{ to: string; channel: string; payload: unknown }> = []

  /**
   * One renderer's `WebContents`, as `ipcMain.handle` hands it to a handler.
   *
   * Named, and recorded with every send, so a test can tell which window a
   * pushed line actually reached rather than only that something was sent.
   * @param name - identifies this renderer in `sent`.
   * @returns the fake sender.
   */
  function sender(name: string): {
    name: string
    destroyed: boolean
    send(channel: string, payload: unknown): void
    isDestroyed(): boolean
  } {
    const contents = {
      name,
      destroyed: false,
      send: (channel: string, payload: unknown) => {
        sent.push({ to: name, channel, payload })
      },
      isDestroyed: () => contents.destroyed,
    }
    return contents
  }

  const windowInstance = {
    webContents: sender('window'),
    isDestroyed: () => false,
    loadFile: vi.fn(async () => {}),
    on: vi.fn(),
    focus: vi.fn(),
  }

  return {
    ipcHandlers,
    sent,
    sender,
    windowInstance,
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
    read: vi.fn(() => ({ configured: true, form: {} as never, plugins: [] })),
    pickFolder: vi.fn(async () => undefined),
    save: vi.fn(async () => ({ ok: true, warnings: [] })),
    acceptPluginUpdate: vi.fn(async () => ({ ok: true, warnings: [] })),
    ...overrides,
  }
}

beforeEach(() => {
  fake.sent.length = 0
  fake.ipcHandlers.clear()
  vi.resetModules()
})

/** An IPC event carrying one renderer as its sender. */
function event(sender: FakeSender): { sender: FakeSender } {
  return { sender }
}

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
    const first = fake.sender('first')
    await saveHandler?.(event(first), {})

    expect(fake.sent).toEqual([
      { to: 'first', channel: 'settings:progress', payload: 'added 455 packages' },
      { to: 'first', channel: 'settings:progress', payload: 'found 0 vulnerabilities' },
    ])
  })

  it('streams an install only to the window that started it, never to one opened later', async () => {
    const { openSettings } = await import('./settings-window')
    let capturedOnProgress: ((line: string) => void) | undefined
    const save = vi.fn(async (_form: unknown, onProgress?: (line: string) => void) => {
      capturedOnProgress = onProgress
      return { ok: true, warnings: [] }
    })
    openSettings(handlers({ save }), () => {})

    const saveHandler = fake.ipcHandlers.get('settings:save')
    const first = fake.sender('first')
    await saveHandler?.(event(first), {})
    // The user closes Settings mid-install and opens it again; the reopened
    // window is a different renderer, and the read it performs must not make
    // it the target of the install still running behind it.
    first.destroyed = true
    const reopened = fake.sender('reopened')
    fake.ipcHandlers.get('settings:read')?.(event(reopened))
    capturedOnProgress?.('added 455 packages')

    expect(fake.sent.filter((entry) => entry.channel === 'settings:progress')).toEqual([])
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
    const first = fake.sender('first')
    await saveHandler?.(event(first), {})
    first.destroyed = true
    capturedOnProgress?.('a line after the window closed')

    expect(fake.sent.find((entry) => entry.payload === 'a line after the window closed')).toBeUndefined()
  })
})

describe('the accept-plugin-update channel', () => {
  it('forwards the package and version, and streams progress the same way save does', async () => {
    const { openSettings } = await import('./settings-window')
    const acceptPluginUpdate = vi.fn(async (_pkg: string, _version: string, onProgress?: (line: string) => void) => {
      onProgress?.('added 3 packages')
      return { ok: true, warnings: [] }
    })
    openSettings(handlers({ acceptPluginUpdate }), () => {})

    const acceptHandler = fake.ipcHandlers.get('settings:accept-plugin-update')
    const first = fake.sender('first')
    const result = await acceptHandler?.(event(first), '@onetest/dsh-deck', '0.3.0')

    expect(acceptPluginUpdate).toHaveBeenCalledWith('@onetest/dsh-deck', '0.3.0', expect.any(Function))
    expect(result).toEqual({ ok: true, warnings: [] })
    expect(fake.sent).toEqual([{ to: 'first', channel: 'settings:progress', payload: 'added 3 packages' }])
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
    const asking = fake.sender('asking')
    readHandler?.(event(asking))
    capturedOnUpdate?.('0.2.0')

    expect(fake.sent).toEqual([{ to: 'asking', channel: 'settings:update-available', payload: '0.2.0' }])
  })

  it('forwards a later plugin update-available result over settings:plugin-update-available', async () => {
    const { openSettings } = await import('./settings-window')
    let capturedOnPluginUpdate: ((pkg: string, latest: string) => void) | undefined
    const read = vi.fn(
      (_onUpdateAvailable?: (latest: string) => void, onPluginUpdateAvailable?: (pkg: string, latest: string) => void) => {
        capturedOnPluginUpdate = onPluginUpdateAvailable
        return { configured: true, form: {} as never, plugins: [] }
      },
    )
    openSettings(handlers({ read }), () => {})

    const readHandler = fake.ipcHandlers.get('settings:read')
    const asking = fake.sender('asking')
    readHandler?.(event(asking))
    capturedOnPluginUpdate?.('@onetest/dsh-deck', '0.2.0')

    expect(fake.sent).toEqual([
      { to: 'asking', channel: 'settings:plugin-update-available', payload: { pkg: '@onetest/dsh-deck', latest: '0.2.0' } },
    ])
  })
})
