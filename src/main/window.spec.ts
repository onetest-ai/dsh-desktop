import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Tests for the main window's drag region.
 *
 * `createWindow` loads the harness Web UI unmodified, so the only lever it
 * has over that content is CSS injected through `webContents.insertCSS` —
 * these tests drive that through a faked `electron` module, the same way
 * `settings-window.spec.ts` and `index.spec.ts` do, so the injection is
 * exercised without a real window.
 */

const fake = vi.hoisted(() => {
  const domReadyHandlers: Array<() => void> = []
  const insertedCss: string[] = []

  const webContents = {
    on: (event: string, handler: () => void) => {
      if (event === 'dom-ready') domReadyHandlers.push(handler)
    },
    insertCSS: vi.fn(async (css: string) => {
      insertedCss.push(css)
      return 'key'
    }),
    setWindowOpenHandler: vi.fn(),
  }

  const windowInstance = {
    webContents,
    once: vi.fn(),
    isVisible: vi.fn(() => false),
    show: vi.fn(),
    loadURL: vi.fn(async () => {}),
  }

  return { domReadyHandlers, insertedCss, webContents, windowInstance }
})

vi.mock('electron', () => ({
  app: { name: 'DeepSeek Harness' },
  BrowserWindow: class {
    constructor() {
      return fake.windowInstance as unknown as InstanceType<typeof import('electron').BrowserWindow>
    }
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  shell: { openExternal: vi.fn() },
}))

beforeEach(() => {
  fake.domReadyHandlers.length = 0
  fake.insertedCss.length = 0
  vi.resetModules()
})

describe('the main window drag region', () => {
  it('exports drag CSS that marks a top strip draggable and interactive elements not draggable', async () => {
    const { DRAG_REGION_CSS } = await import('./window')
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: drag')
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: no-drag')
    expect(DRAG_REGION_CSS).toMatch(/button,\s*a,\s*input/)
  })

  it('inserts the drag CSS into the window on every dom-ready', async () => {
    const { createWindow } = await import('./window')
    createWindow()

    expect(fake.domReadyHandlers).toHaveLength(1)
    fake.domReadyHandlers[0]?.()
    fake.domReadyHandlers[0]?.()

    expect(fake.webContents.insertCSS).toHaveBeenCalledTimes(2)
    expect(fake.insertedCss[0]).toContain('-webkit-app-region: drag')
  })
})
