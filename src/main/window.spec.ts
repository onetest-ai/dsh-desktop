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
  const resizeHandlers: Array<() => void> = []
  const views: Array<{ preload: string | undefined; bounds?: unknown; visible?: boolean }> = []

  /** One view's `webContents`, recording what `createWindow` does to it. */
  const contents = (): Record<string, unknown> => ({
    on: (event: string, handler: () => void) => {
      if (event === 'dom-ready') domReadyHandlers.push(handler)
    },
    insertCSS: vi.fn(async (css: string) => {
      insertedCss.push(css)
      return 'key'
    }),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async () => {}),
    loadFile: vi.fn(async () => {}),
  })

  const windowInstance = {
    webContents: contents(),
    contentView: { addChildView: vi.fn() },
    on: (event: string, handler: () => void) => {
      if (event === 'resize') resizeHandlers.push(handler)
    },
    once: vi.fn(),
    isVisible: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    getContentSize: vi.fn(() => [1280, 860]),
    show: vi.fn(),
    loadFile: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
  }

  return { domReadyHandlers, insertedCss, resizeHandlers, views, contents, windowInstance }
})

vi.mock('electron', () => ({
  app: { name: 'DeepSeek Harness' },
  BrowserWindow: class {
    constructor() {
      return fake.windowInstance as unknown as InstanceType<typeof import('electron').BrowserWindow>
    }
  },
  WebContentsView: class {
    webContents = fake.contents()
    setBounds = vi.fn((bounds: unknown) => {
      fake.views[this.index].bounds = bounds
    })
    setVisible = vi.fn((visible: boolean) => {
      fake.views[this.index].visible = visible
    })
    index: number
    constructor(options: { webPreferences?: { preload?: string } }) {
      this.index = fake.views.length
      fake.views.push({ preload: options.webPreferences?.preload })
    }
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  shell: { openExternal: vi.fn() },
}))

beforeEach(() => {
  fake.domReadyHandlers.length = 0
  fake.insertedCss.length = 0
  fake.resizeHandlers.length = 0
  fake.views.length = 0
  vi.resetModules()
})

/** The pane's stored state, as `index.ts` holds it. */
const CLOSED = { width: 420, open: false }

describe('the main window drag region', () => {
  it('exports drag CSS that marks a top strip draggable and interactive elements not draggable', async () => {
    const { DRAG_REGION_CSS } = await import('./window')
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: drag')
    expect(DRAG_REGION_CSS).toContain('-webkit-app-region: no-drag')
    expect(DRAG_REGION_CSS).toMatch(/button,\s*a,\s*input/)
  })

  it('inserts the drag CSS into the harness view on every dom-ready', async () => {
    const { createWindow } = await import('./window')
    createWindow(CLOSED)

    expect(fake.domReadyHandlers).toHaveLength(1)
    fake.domReadyHandlers[0]?.()
    fake.domReadyHandlers[0]?.()

    expect(fake.insertedCss).toHaveLength(2)
    expect(fake.insertedCss[0]).toContain('-webkit-app-region: drag')
  })
})

describe('the window\'s views', () => {
  // reason: the harness Web UI is foreign content this app loads unmodified.
  // A preload there would expose this app's channels to it.
  it('gives the harness view no preload, and the pane one', async () => {
    const { createWindow } = await import('./window')
    createWindow(CLOSED)
    expect(fake.views).toHaveLength(2)
    expect(fake.views[0].preload).toBeUndefined()
    expect(fake.views[1].preload).toMatch(/pane\.js$/)
  })

  it('starts with the pane hidden and the harness filling the window', async () => {
    const { createWindow } = await import('./window')
    createWindow(CLOSED)
    expect(fake.views[0].bounds).toEqual({ x: 0, y: 0, width: 1280, height: 860 })
    expect(fake.views[1].visible).toBe(false)
  })

  // reason: `WebContentsView` has no layout of its own — nothing moves when
  // the window resizes unless this puts it back.
  it('re-lays the views out when the window resizes', async () => {
    const { createWindow } = await import('./window')
    createWindow({ width: 420, open: true })
    fake.windowInstance.getContentSize.mockReturnValue([1200, 600])
    expect(fake.resizeHandlers).toHaveLength(1)
    fake.resizeHandlers[0]?.()
    expect(fake.views[0].bounds).toMatchObject({ width: 1200 - 420 - 6, height: 600 })
    expect(fake.views[1].bounds).toMatchObject({ width: 420, height: 600 })
  })
})
