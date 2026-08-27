import { describe, expect, it } from 'vitest'
import { DIVIDER_WIDTH, MIN_FILES_WIDTH, MIN_HARNESS_WIDTH, layout, type Columns } from './layout'

/** A 1280x860 window, the size the app opens at. */
const BOUNDS = { width: 1280, height: 860 }

/** Column state with both closed, overridable per test. */
function columns(overrides: Partial<Columns> = {}): Columns {
  return { editor: { width: 520, open: false }, files: { width: 240, open: false }, ...overrides }
}

/** Every part's width, in the order they appear left to right. */
function widths(bounds: { width: number; height: number }, state: Columns): number[] {
  const places = layout(bounds, state)
  return [places.harness, places.editorDivider, places.editor, places.filesDivider, places.files].map(
    (rect) => rect.width,
  )
}

describe('layout', () => {
  it('gives the harness the whole window when both columns are closed', () => {
    expect(widths(BOUNDS, columns())).toEqual([1280, 0, 0, 0, 0])
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
    expect(widths(BOUNDS, columns({ files: { width: 240, open: true } }))).toEqual([1280 - 6 - 240, 0, 0, 6, 240])
    expect(widths(BOUNDS, columns({ editor: { width: 520, open: true } }))).toEqual([1280 - 6 - 520, 6, 520, 0, 0])
  })

  it('honours each stored width when the window can afford it', () => {
    const places = layout(BOUNDS, columns({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    expect(places.editor.width).toBe(520)
    expect(places.files.width).toBe(240)
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

  it('gives every part the full window height', () => {
    const places = layout(BOUNDS, columns({ editor: { width: 520, open: true }, files: { width: 240, open: true } }))
    for (const rect of Object.values(places)) expect(rect).toMatchObject({ y: 0, height: 860 })
  })
})
