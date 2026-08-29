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
  const loadHandlers: Array<() => void> = []
  const domReadyHandlers: Array<() => void> = []
  const insertedCss: string[] = []
  const resizeHandlers: Array<() => void> = []
  const views: Array<{ preload: string | undefined; bounds?: unknown; visible?: boolean }> = []

  /** One view's `webContents`, recording what `createWindow` does to it. */
  const contents = (): Record<string, unknown> => ({
    on: (event: string, handler: () => void) => {
      if (event === 'dom-ready') domReadyHandlers.push(handler)
      if (event === 'did-finish-load') loadHandlers.push(handler)
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
    webContents: { ...contents(), send: vi.fn() },
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

  return { loadHandlers, domReadyHandlers, insertedCss, resizeHandlers, views, contents, windowInstance }
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
  // The resize test moves this; without a reset the next test lays out a
  // window of that size and every coordinate in it is off.
  fake.windowInstance.getContentSize.mockReturnValue([1280, 860])
  fake.domReadyHandlers.length = 0
  fake.loadHandlers.length = 0
  fake.windowInstance.webContents.send.mockClear()
  fake.insertedCss.length = 0
  fake.resizeHandlers.length = 0
  fake.views.length = 0
  vi.resetModules()
})

/** The columns' stored state, as `index.ts` holds them. */
const PANEL = { width: 720, height: 240, open: false }
const CLOSED = { editor: { width: 520, open: false }, files: { width: 220, open: false }, terminal: PANEL }
const OPEN = { editor: { width: 520, open: true }, files: { width: 240, open: true }, terminal: PANEL }

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
  // reason: the harness Web UI is loaded unmodified and hosts other packages'
  // browser halves, so it must not get the pane's preload — its own exposes
  // one no-argument call and nothing else.
  it('gives each view its own preload, and the web view none at all', async () => {
    const { createWindow } = await import('./window')
    createWindow(CLOSED)
    expect(fake.views).toHaveLength(5)
    expect(fake.views[0].preload).toMatch(/harness\.js$/)
    expect(fake.views[1].preload).toMatch(/pane\.js$/)
    expect(fake.views[2].preload).toMatch(/pane\.js$/)
    // The terminal's own preload: it exposes a shell it never names, and
    // nothing the pane's preload exposes.
    expect(fake.views[3].preload).toMatch(/terminal\.js$/)
    // Whatever the Web tab loads is foreign: it gets nothing.
    expect(fake.views[4].preload).toBeUndefined()
  })

  it('starts with both columns hidden and the harness filling what the rail leaves', async () => {
    const { createWindow } = await import('./window')
    createWindow(CLOSED)
    expect(fake.views[0].bounds).toEqual({ x: 0, y: 0, width: 1280 - 30, height: 860 })
    expect(fake.views[1].visible).toBe(false)
    expect(fake.views[2].visible).toBe(false)
  })

  // reason: the rail and the dividers have no position in `shell.css` — they
  // are placed only by `shell:places`. The first layout pass runs while the
  // page is still loading, and a page mid-load drops what is sent to it: the
  // rail then sits at the window's left edge behind the harness view, and no
  // divider has a gap to be grabbed by.
  it('places the rail and the dividers again once its page has loaded', async () => {
    const { createWindow } = await import('./window')
    createWindow(OPEN)
    expect(fake.loadHandlers, 'nothing re-places the page after it loads').toHaveLength(1)
    fake.windowInstance.webContents.send.mockClear()
    for (const handler of fake.loadHandlers) handler()
    expect(fake.windowInstance.webContents.send).toHaveBeenCalledWith(
      'shell:places',
      expect.objectContaining({ rail: expect.objectContaining({ x: 1280 - 30, width: 30 }) }),
    )
  })

  // reason: the web view covers the editor column. Placed over the tab strip
  // it would take the tabs with it, leaving no way back to the editor.
  it('leaves the editor column’s tab strip and address bar uncovered by the web view', async () => {
    const { createWindow, applyLayout } = await import('./window')
    const views = createWindow(OPEN)
    applyLayout(views, OPEN, true)
    const editor = fake.views[1].bounds as { x: number; y: number; height: number }
    const web = fake.views[4].bounds as { x: number; y: number; height: number }
    expect(web.x).toBe(editor.x)
    // Both strips: 35px of tabs and 35px of address bar.
    expect(web.y).toBe(editor.y + 70)
    expect(web.height).toBe(editor.height - 70)
  })

  it('shows the web view only when the editor column is open and its tab is chosen', async () => {
    const { createWindow, applyLayout } = await import('./window')
    const views = createWindow(OPEN)
    applyLayout(views, OPEN, true)
    expect(fake.views[4].visible).toBe(true)
    applyLayout(views, OPEN, false)
    expect(fake.views[4].visible).toBe(false)
    applyLayout(views, CLOSED, true)
    expect(fake.views[4].visible).toBe(false)
  })

  // reason: `WebContentsView` has no layout of its own — nothing moves when
  // the window resizes unless this puts it back.
  it('re-lays the views out when the window resizes', async () => {
    const { createWindow } = await import('./window')
    createWindow({ editor: { width: 420, open: true }, files: { width: 240, open: false }, terminal: PANEL })
    fake.windowInstance.getContentSize.mockReturnValue([1200, 600])
    expect(fake.resizeHandlers).toHaveLength(1)
    fake.resizeHandlers[0]?.()
    expect(fake.views[0].bounds).toMatchObject({ width: 1200 - 30 - 420 - 8, height: 600 })
    expect(fake.views[1].bounds).toMatchObject({ width: 420, height: 600 })
  })

  // reason: the window's own page draws the dividers and cannot see where the
  // views are. Both would otherwise fill the page and the one drawn last would
  // take every pointer event, including the other column's.
  it('tells the window page where the dividers and the rail go', async () => {
    const { createWindow, applyLayout } = await import('./window')
    const views = createWindow(OPEN)
    applyLayout(views, OPEN, false)
    const sent = (fake.windowInstance.webContents.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)
    expect(sent?.[0]).toBe('shell:places')
    expect(sent?.[1].editor.width).toBe(8)
    expect(sent?.[1].files.x).toBeGreaterThan(sent?.[1].editor.x)
    expect(sent?.[1].rail).toMatchObject({ x: 1280 - 30, width: 30 })
  })

  // reason: the rail's buttons say what the window is showing, not only what
  // it can show, so the state travels with the places.
  // reason: the panel is a view like the others, and a closed one that kept
  // its bounds would sit over the columns it is meant to be under.
  it('shows the terminal panel only when it is open', async () => {
    const { createWindow, applyLayout } = await import('./window')
    const views = createWindow(CLOSED)
    expect(fake.views[3].visible).toBe(false)
    applyLayout(views, { ...OPEN, terminal: { width: 720, height: 240, open: true } }, false)
    expect(fake.views[3].visible).toBe(true)
    expect(fake.views[3].bounds).toMatchObject({ height: 240 })
  })

  it('tells the window page which columns are up', async () => {
    const { createWindow, applyLayout } = await import('./window')
    const views = createWindow(OPEN)
    applyLayout(views, OPEN, true)
    const sent = (fake.windowInstance.webContents.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)
    expect(sent?.[1].open).toEqual({ editor: true, files: true, terminal: false, web: true })
    applyLayout(views, CLOSED, true)
    const closed = (fake.windowInstance.webContents.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)
    expect(closed?.[1].open).toEqual({ editor: false, files: false, terminal: false, web: false })
  })
})
