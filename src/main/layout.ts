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

/**
 * The most of the window a bottom-docked terminal may take.
 *
 * It only docks along the bottom when the editor is using the column above
 * it; past half the window the thing being worked on is smaller than the
 * terminal watching it.
 */
export const MAX_TERMINAL_FRACTION = 0.5

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
  // The terminal fills the editor's slot whenever the editor is not using it —
  // full height beside the tree, or the whole split when the tree is closed
  // too. It docks along the bottom only when both are up, because only then is
  // there something above it to keep.
  const panelOpen = columns.terminal.open
  const docked = panelOpen && columns.editor.open
  const panelHeight = docked
    ? Math.min(
      Math.max(columns.terminal.height, MIN_TERMINAL_HEIGHT),
      Math.floor(bounds.height * MAX_TERMINAL_FRACTION),
    )
    : 0
  const bandHeight = Math.max(0, bounds.height - panelHeight - (docked ? DIVIDER_WIDTH : 0))
  // The panel sits under this app's own columns, not under the conversation:
  // the harness and the rail keep the window's full height, and only the
  // columns give up the band the panel takes.
  const full = { y: 0, height: bounds.height }
  const band = { y: 0, height: bandHeight }
  const railWidth = Math.min(RAIL_WIDTH, bounds.width)
  const rail = { x: bounds.width - railWidth, width: railWidth, ...full }
  // Everything else divides what the rail leaves.
  const usable = bounds.width - railWidth
  const open = [
    { key: 'editor' as const, state: columns.editor, min: MIN_EDITOR_WIDTH },
    { key: 'files' as const, state: columns.files, min: MIN_FILES_WIDTH },
  ].filter((column) => column.state.open)

  const gaps = open.length * DIVIDER_WIDTH + (panelOpen && !columns.editor.open ? DIVIDER_WIDTH : 0)
  const available = Math.max(0, usable - gaps)
  const wanted = open.map((column) => Math.max(column.state.width, column.min))
  const total = wanted.reduce((sum, width) => sum + width, 0)
  const spare = Math.max(0, available - MIN_HARNESS_WIDTH)

  // Scaled together rather than trimmed one at a time: taking it all from the
  // last column would collapse the tree the moment the window narrowed, while
  // both are still readable at a share of what they asked for.
  const scale = total > spare && total > 0 ? spare / total : 1
  const widths = wanted.map((width) => Math.floor(width * scale))
  const used = widths.reduce((sum, width) => sum + width, 0)

  // Standing in for the editor, the terminal asks for what the editor would
  // have: beside an open tree that is the editor's width, and with the tree
  // closed as well it is the whole split. Clamped against what the columns
  // and their gaps have already taken, so the harness keeps its minimum.
  const soloWidth = panelOpen && !columns.editor.open
    ? Math.min(
      Math.max(columns.terminal.width, MIN_TERMINAL_WIDTH),
      Math.max(0, available - MIN_HARNESS_WIDTH - used),
    )
    : 0

  let x = available - used - soloWidth
  const harness = { x: 0, width: Math.max(0, x), ...full }
  const bandStart = Math.max(0, x)
  const bandWidth = usable - bandStart
  // Standing in for the editor, the terminal is placed first, in the editor's
  // slot, and the columns that remain follow it.
  const slot = soloWidth > 0
    ? { divider: { x, width: DIVIDER_WIDTH, ...full }, panel: { x: x + DIVIDER_WIDTH, width: soloWidth, ...full } }
    : undefined
  if (slot !== undefined) x += DIVIDER_WIDTH + soloWidth
  const places: Record<string, Rect> = {
    editor: { x: rail.x, width: 0, ...band },
    files: { x: rail.x, width: 0, ...band },
    editorDivider: { x: rail.x, width: 0, ...band },
    filesDivider: { x: rail.x, width: 0, ...band },
  }
  open.forEach((column, index) => {
    // The first divider borders the harness, which keeps the window's full
    // height — so it runs the full height too, past the docked panel's left
    // edge. Cut to the band it would leave that edge with no seam against the
    // conversation at all. Dividers between two columns stop where they do.
    const bordersHarness = index === 0 && slot === undefined
    places[`${column.key}Divider`] = { x, width: DIVIDER_WIDTH, ...(bordersHarness ? full : band) }
    x += DIVIDER_WIDTH
    places[column.key] = { x, width: widths[index], ...band }
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
    // Docked along the bottom of the columns, or standing in the editor's own
    // slot at full height. Closed, it has no size at all.
    // Docked, it starts after the divider that borders the harness rather than
    // at it: that divider is a gap the window's own page shows through, and a
    // view laid over the gap hides the seam and swallows the drag.
    terminalDivider: docked
      ? { x: bandStart + DIVIDER_WIDTH, y: bandHeight, width: bandWidth - DIVIDER_WIDTH, height: DIVIDER_WIDTH }
      : slot?.divider ?? empty,
    terminal: docked
      ? {
        x: bandStart + DIVIDER_WIDTH,
        y: bandHeight + DIVIDER_WIDTH,
        width: bandWidth - DIVIDER_WIDTH,
        height: panelHeight,
      }
      : slot?.panel ?? empty,
  }
}
