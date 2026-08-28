/**
 * How wide the gap beside each column is.
 *
 * A divider is not a view of its own: it is the window's own page showing
 * through the gap the views leave, which is what lets it receive the drag
 * without a `WebContentsView` stacked over either neighbour.
 *
 * The gap is the hit target, not the seam. Only 1px of it is painted (see
 * `shell.css`), matching the harness, which resizes its own columns with a
 * 1px border under an 8px invisible strip — a 1px target is not one a pointer
 * can find.
 */
export const DIVIDER_WIDTH = 8

/** Below this the harness Web UI's own layout collapses, so the columns stop taking width. */
export const MIN_HARNESS_WIDTH = 480

/**
 * How wide the rail on the right edge is.
 *
 * Always present, and the only chrome of this app's own that is visible when
 * every column is closed — which is what makes the tree and the browser
 * reachable without a menu.
 */
export const RAIL_WIDTH = 30

/** Below these a column shows nothing worth reading. */
export const MIN_EDITOR_WIDTH = 320
export const MIN_FILES_WIDTH = 180

/**
 * Below this a terminal wraps every command it is given.
 *
 * Eighty columns is the width shell output has been written for since before
 * any of it was written; narrower and `git status` and a stack trace both
 * become unreadable.
 */
export const MIN_TERMINAL_WIDTH = 480

/** Below this the terminal shows too few lines to follow what a command did. */
export const MIN_TERMINAL_HEIGHT = 120

/** A view's bounds, in the window's coordinates. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One resizable column's stored state. */
export interface ColumnState {
  width: number
  open: boolean
}

/** The two columns this app puts beside the harness. */
export interface Columns {
  editor: ColumnState
  files: ColumnState
  /**
   * The terminal panel, whose stored `width` is what it claims for itself when
   * no column is open to sit under.
   */
  terminal: PanelState
}

/** The terminal panel's stored state. */
export interface PanelState extends ColumnState {
  /** How tall the panel is; its width comes from the columns it sits under. */
  height: number
}

/** Where each of the window's parts goes, left to right. */
export interface Layout {
  harness: Rect
  /** The strip at the right edge the window's own page draws its buttons in. */
  rail: Rect
  /** The gap before the editor column; zero-width when that column is closed. */
  editorDivider: Rect
  editor: Rect
  /** The gap before the files column; zero-width when that column is closed. */
  filesDivider: Rect
  files: Rect
  /** The gap above the terminal panel; zero-height when it is closed. */
  terminalDivider: Rect
  /** The terminal panel along the bottom of the columns; zero-sized when closed. */
  terminal: Rect
}

/**
 * Place the harness, the editor column, the file tree, and the gaps between
 * them.
 *
 * The order is the mirror of an IDE's: the conversation on the left, what it
 * is working on in the middle, the tree on the right, and a rail of buttons
 * on the outside edge.
 *
 * Pure arithmetic, deliberately free of any Electron import: this is the part
 * of the split worth testing exhaustively, and it should not need a window to
 * test. A requested width is honoured only as far as the minimums allow —
 * when the window cannot give every column what it asks for, the columns
 * shrink together rather than one of them disappearing.
 * @param bounds - the window's content size.
 * @param columns - each column's stored width and whether it is showing.
 * @returns bounds for all five parts, together covering the window exactly.
 */
export function layout(bounds: { width: number; height: number }, columns: Columns): Layout {
  // The terminal takes its height off the bottom of the columns' band, so
  // every column is laid out into what it leaves.
  const panelOpen = columns.terminal.open
  const panelHeight = panelOpen
    ? Math.min(Math.max(columns.terminal.height, MIN_TERMINAL_HEIGHT), bounds.height)
    : 0
  const bandHeight = Math.max(0, bounds.height - panelHeight - (panelOpen ? DIVIDER_WIDTH : 0))
  const full = { y: 0, height: bandHeight }
  const railWidth = Math.min(RAIL_WIDTH, bounds.width)
  const rail = { x: bounds.width - railWidth, width: railWidth, ...full }
  // Everything else divides what the rail leaves.
  const usable = bounds.width - railWidth
  const open = [
    { key: 'editor' as const, state: columns.editor, min: MIN_EDITOR_WIDTH },
    { key: 'files' as const, state: columns.files, min: MIN_FILES_WIDTH },
  ].filter((column) => column.state.open)

  const gaps = open.length * DIVIDER_WIDTH
  const available = Math.max(0, usable - gaps)
  const wanted = open.map((column) => Math.max(column.state.width, column.min))
  // The panel spans whatever the columns occupy. With none open it has
  // nothing to sit under, so it claims a band of its own and the harness
  // gives up the width — otherwise the toggle would appear to do nothing.
  const soloWidth = panelOpen && open.length === 0
    ? Math.min(Math.max(columns.terminal.width, MIN_TERMINAL_WIDTH), Math.max(0, usable - MIN_HARNESS_WIDTH))
    : 0
  const total = wanted.reduce((sum, width) => sum + width, 0)
  const spare = Math.max(0, available - MIN_HARNESS_WIDTH)

  // Scaled together rather than trimmed one at a time: taking it all from the
  // last column would collapse the tree the moment the window narrowed, while
  // both are still readable at a share of what they asked for.
  const scale = total > spare && total > 0 ? spare / total : 1
  const widths = wanted.map((width) => Math.floor(width * scale))
  const used = widths.reduce((sum, width) => sum + width, 0)

  let x = available - used - soloWidth
  const harness = { x: 0, width: Math.max(0, x), ...full }
  const bandStart = Math.max(0, x)
  const bandWidth = usable - bandStart
  const places: Record<string, Rect> = {
    editor: { x: rail.x, width: 0, ...full },
    files: { x: rail.x, width: 0, ...full },
    editorDivider: { x: rail.x, width: 0, ...full },
    filesDivider: { x: rail.x, width: 0, ...full },
  }
  open.forEach((column, index) => {
    places[`${column.key}Divider`] = { x, width: DIVIDER_WIDTH, ...full }
    x += DIVIDER_WIDTH
    places[column.key] = { x, width: widths[index], ...full }
    x += widths[index]
  })

  const empty = { x: bandStart, y: bounds.height, width: 0, height: 0 }
  return {
    harness,
    rail,
    editorDivider: places.editorDivider,
    editor: places.editor,
    filesDivider: places.filesDivider,
    files: places.files,
    terminalDivider: panelOpen
      ? { x: bandStart, y: bandHeight, width: bandWidth, height: DIVIDER_WIDTH }
      : empty,
    terminal: panelOpen
      ? { x: bandStart, y: bandHeight + DIVIDER_WIDTH, width: bandWidth, height: panelHeight }
      : empty,
  }
}
