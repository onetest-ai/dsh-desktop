import { describe, expect, it } from 'vitest'
import { DIVIDER_WIDTH, MIN_HARNESS_WIDTH, MIN_PANE_WIDTH, layout } from './layout'

/** A 1280x860 window, the size the app opens at. */
const BOUNDS = { width: 1280, height: 860 }

describe('layout', () => {
  it('gives the harness the whole window when the pane is closed', () => {
    expect(layout(BOUNDS, { width: 420, open: false })).toEqual({
      harness: { x: 0, y: 0, width: 1280, height: 860 },
      pane: { x: 1280, y: 0, width: 0, height: 860 },
      divider: { x: 1280, y: 0, width: 0, height: 860 },
    })
  })

  // reason: the divider is the window's own page showing through the gap, so
  // the gap has to be exactly its width — a pane that abuts the harness would
  // leave nothing to grab.
  it('leaves the divider between the two when the pane is open', () => {
    const { harness, pane, divider } = layout(BOUNDS, { width: 420, open: true })
    expect(pane.width).toBe(420)
    expect(divider.width).toBe(DIVIDER_WIDTH)
    expect(harness.width + divider.width + pane.width).toBe(BOUNDS.width)
    expect(divider.x).toBe(harness.width)
    expect(pane.x).toBe(harness.width + DIVIDER_WIDTH)
  })

  it('clamps a pane that would leave the harness unusable', () => {
    const { harness, pane } = layout(BOUNDS, { width: 1270, open: true })
    expect(harness.width).toBe(MIN_HARNESS_WIDTH)
    expect(pane.width).toBe(BOUNDS.width - MIN_HARNESS_WIDTH - DIVIDER_WIDTH)
  })

  it('clamps a pane too narrow to show anything', () => {
    expect(layout(BOUNDS, { width: 20, open: true }).pane.width).toBe(MIN_PANE_WIDTH)
  })

  // reason: a window narrower than both minimums plus the divider cannot
  // satisfy them, and negative widths crash `setBounds`.
  it('never produces a negative width in a window too small for both', () => {
    const { harness, pane, divider } = layout({ width: 300, height: 400 }, { width: 420, open: true })
    expect(harness.width).toBeGreaterThanOrEqual(0)
    expect(pane.width).toBeGreaterThanOrEqual(0)
    expect(harness.width + divider.width + pane.width).toBe(300)
  })

  it('gives every view the full window height', () => {
    const { harness, pane, divider } = layout(BOUNDS, { width: 420, open: true })
    for (const rect of [harness, pane, divider]) expect(rect).toMatchObject({ y: 0, height: 860 })
  })
})
