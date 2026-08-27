/**
 * How wide the gap between the harness and the pane is.
 *
 * The divider is not a view of its own: it is the window's own page showing
 * through the gap the two views leave, which is what lets it receive the
 * drag without a third `WebContentsView` stacked over either one.
 */
export const DIVIDER_WIDTH = 6

/** Below this the harness Web UI's own layout collapses, so the pane stops taking width. */
export const MIN_HARNESS_WIDTH = 480

/** Below this the pane shows a file tree too narrow to read. */
export const MIN_PANE_WIDTH = 240

/** A view's bounds, in the window's coordinates. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where each of the window's parts goes. */
export interface Layout {
  harness: Rect
  /** Zero-width when the pane is closed, so the harness has the whole window. */
  pane: Rect
  /** The gap the window's own page draws the divider in; zero-width when closed. */
  divider: Rect
}

/**
 * Place the harness, the pane, and the divider gap inside the window.
 *
 * Pure arithmetic, deliberately free of any Electron import: this is the one
 * part of the split that is worth testing exhaustively, and it should not
 * need a window to test.
 *
 * The requested pane width is honoured only as far as both minimums allow. A
 * window too small to satisfy either one gives the harness whatever is left
 * rather than a negative width, which `setBounds` would reject.
 * @param bounds - the window's content size.
 * @param pane - the pane's stored width and whether it is showing.
 * @returns bounds for all three parts, together covering the window exactly.
 */
export function layout(bounds: { width: number; height: number }, pane: { width: number; open: boolean }): Layout {
  const full = { y: 0, height: bounds.height }
  if (!pane.open) {
    return {
      harness: { x: 0, width: bounds.width, ...full },
      pane: { x: bounds.width, width: 0, ...full },
      divider: { x: bounds.width, width: 0, ...full },
    }
  }

  const available = Math.max(0, bounds.width - DIVIDER_WIDTH)
  const widest = Math.max(0, available - MIN_HARNESS_WIDTH)
  const paneWidth = Math.min(Math.max(pane.width, Math.min(MIN_PANE_WIDTH, available)), Math.max(widest, 0))
  const harnessWidth = available - paneWidth

  return {
    harness: { x: 0, width: harnessWidth, ...full },
    divider: { x: harnessWidth, width: DIVIDER_WIDTH, ...full },
    pane: { x: harnessWidth + DIVIDER_WIDTH, width: paneWidth, ...full },
  }
}
