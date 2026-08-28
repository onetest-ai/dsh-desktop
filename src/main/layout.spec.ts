import { describe, expect, it } from 'vitest'
import { DIVIDER_WIDTH, MIN_FILES_WIDTH, MIN_HARNESS_WIDTH, RAIL_WIDTH, layout, type Columns } from './layout'

/** A 1280x860 window, the size the app opens at. */
const BOUNDS = { width: 1280, height: 860 }

/** Column state with both closed, overridable per test. */
function columns(overrides: Partial<Columns> = {}): Columns {
  return {
    editor: { width: 520, open: false },
    files: { width: 240, open: false },
    terminal: { width: 720, height: 240, open: false },
    ...overrides,
  }
}

/** Every part's width, in the order they appear left to right. */
function widths(bounds: { width: number; height: number }, state: Columns): number[] {
  const places = layout(bounds, state)
  return [places.harness, places.editorDivider, places.editor, places.filesDivider, places.files, places.rail].map(
    (rect) => rect.width,
  )
}

describe('layout', () => {
  it('gives the harness everything the rail leaves when both columns are closed', () => {
    expect(widths(BOUNDS, columns())).toEqual([1280 - RAIL_WIDTH, 0, 0, 0, 0, RAIL_WIDTH])
  })

  // reason: it is the only chrome of this app's own that is visible when
  // every column is closed, so it is what makes them reachable at all.
  it('keeps the rail on the right edge in every state', () => {
    for (const editor of [true, false]) {
      for (const files of [true, false]) {
        const places = layout(BOUNDS, columns({ editor: { width: 520, open: editor }, files: { width: 220, open: files } }))
        expect(places.rail).toMatchObject({ x: BOUNDS.width - RAIL_WIDTH, width: RAIL_WIDTH })
      }
    }
  })

  // reason: the order is the mirror of an IDE's — conversation left, what it
  // is working on in the middle, the tree on the right.
  it('places the editor between the harness and the file tree', () => {
    const places = layout(BOUNDS, columns({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    expect(places.harness.x).toBe(0)
    expect(places.editorDivider.x).toBe(places.harness.width)
    expect(places.editor.x).toBe(places.editorDivider.x + DIVIDER_WIDTH)
    expect(places.filesDivider.x).toBe(places.editor.x + places.editor.width)
    expect(places.files.x).toBe(places.filesDivider.x + DIVIDER_WIDTH)
    expect(places.rail.x).toBe(places.files.x + places.files.width)
  })

  it('covers the window exactly, whichever columns are open', () => {
    for (const editor of [true, false]) {
      for (const files of [true, false]) {
        const state = columns({ editor: { width: 520, open: editor }, files: { width: 240, open: files } })
        expect(widths(BOUNDS, state).reduce((sum, width) => sum + width, 0)).toBe(BOUNDS.width)
      }
    }
  })

  it('leaves one divider per open column', () => {
    const usable = 1280 - RAIL_WIDTH
    expect(widths(BOUNDS, columns({ files: { width: 240, open: true } }))).toEqual([
      usable - DIVIDER_WIDTH - 240, 0, 0, DIVIDER_WIDTH, 240, RAIL_WIDTH,
    ])
    expect(widths(BOUNDS, columns({ editor: { width: 520, open: true } }))).toEqual([
      usable - DIVIDER_WIDTH - 520, DIVIDER_WIDTH, 520, 0, 0, RAIL_WIDTH,
    ])
  })

  it('honours each stored width when the window can afford it', () => {
    const places = layout(BOUNDS, columns({ editor: { width: 520, open: true }, files: { width: 220, open: true } }))
    expect(places.editor.width).toBe(520)
    expect(places.files.width).toBe(220)
  })

  it('never lets a column open below its own minimum', () => {
    const places = layout(BOUNDS, columns({ files: { width: 20, open: true } }))
    expect(places.files.width).toBe(MIN_FILES_WIDTH)
  })

  // reason: taking it all from the last column would collapse the tree the
  // moment the window narrowed, while both are still readable at a share.
  it('shrinks both columns together rather than collapsing one', () => {
    const narrow = { width: 900, height: 860 }
    const places = layout(narrow, columns({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    expect(places.editor.width).toBeGreaterThan(0)
    expect(places.files.width).toBeGreaterThan(0)
    expect(places.editor.width).toBeLessThan(520)
    expect(places.files.width).toBeLessThan(240)
  })

  it('keeps the harness at its minimum once the columns have been scaled', () => {
    const narrow = { width: 900, height: 860 }
    const places = layout(narrow, columns({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    expect(places.harness.width).toBeGreaterThanOrEqual(MIN_HARNESS_WIDTH)
  })

  // reason: negative widths crash `setBounds`, and a window this small still
  // has to render something.
  it('never produces a negative width in a window too small for anything', () => {
    const tiny = { width: 300, height: 400 }
    const all = widths(tiny, columns({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    for (const width of all) expect(width).toBeGreaterThanOrEqual(0)
    expect(all.reduce((sum, width) => sum + width, 0)).toBe(tiny.width)
  })

  it('gives every column the full window height while the terminal is closed', () => {
    const places = layout(BOUNDS, columns({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    for (const [name, rect] of Object.entries(places)) {
      if (name.startsWith('terminal')) continue
      expect(rect, name).toMatchObject({ y: 0, height: 860 })
    }
  })

  it('gives the terminal no size at all while it is closed', () => {
    const places = layout(BOUNDS, columns({ editor: { width: 520, open: true } }))
    expect(places.terminal).toMatchObject({ width: 0, height: 0 })
    expect(places.terminalDivider).toMatchObject({ width: 0, height: 0 })
  })
})

describe('the terminal panel', () => {
  const withPanel = (overrides: Partial<Columns> = {}): Columns =>
    columns({ terminal: { width: 720, height: 240, open: true }, ...overrides })

  it('sits along the bottom, under the columns, with a gap above it', () => {
    const places = layout(BOUNDS, withPanel({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    expect(places.terminal).toMatchObject({ y: 860 - 240, height: 240 })
    expect(places.terminalDivider).toMatchObject({ y: 860 - 240 - DIVIDER_WIDTH, height: DIVIDER_WIDTH })
    // Its top edge is where the columns now stop.
    expect(places.editor.height).toBe(860 - 240 - DIVIDER_WIDTH)
    expect(places.files.height).toBe(places.editor.height)
  })

  // reason: it is one panel across everything this app owns, not a panel per
  // column, so it starts where the harness stops and runs to the rail.
  it('spans the columns it sits under', () => {
    const places = layout(BOUNDS, withPanel({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    expect(places.terminal.x).toBe(places.editorDivider.x)
    expect(places.terminal.x + places.terminal.width).toBe(places.rail.x)
    expect(places.terminalDivider.x).toBe(places.terminal.x)
    expect(places.terminalDivider.width).toBe(places.terminal.width)
  })

  it('spans one open column just the same', () => {
    const places = layout(BOUNDS, withPanel({ files: { width: 240, open: true } }))
    expect(places.terminal.x).toBe(places.filesDivider.x)
    expect(places.terminal.x + places.terminal.width).toBe(places.rail.x)
  })

  // reason: with nothing to sit under it would be zero-width, and the toggle
  // would look like it did nothing at all.
  it('claims a band of its own when no column is open', () => {
    const places = layout(BOUNDS, withPanel())
    expect(places.terminal.width).toBe(720)
    expect(places.terminal.x + places.terminal.width).toBe(places.rail.x)
    expect(places.harness.width).toBe(1280 - RAIL_WIDTH - 720)
  })

  it('leaves the harness usable when it claims that band', () => {
    const places = layout({ width: 900, height: 860 }, withPanel())
    expect(places.harness.width).toBeGreaterThanOrEqual(MIN_HARNESS_WIDTH)
    expect(places.terminal.width).toBeGreaterThan(0)
  })

  it('never asks for more height than the window has', () => {
    const places = layout({ width: 1280, height: 200 }, withPanel({ editor: { width: 520, open: true } }))
    expect(places.terminal.height).toBeLessThanOrEqual(200)
    expect(places.editor.height).toBeGreaterThanOrEqual(0)
  })

  it('covers the window exactly, top to bottom', () => {
    const places = layout(BOUNDS, withPanel({ editor: { width: 520, open: true } }))
    expect(places.editor.height + places.terminalDivider.height + places.terminal.height).toBe(860)
  })
})
