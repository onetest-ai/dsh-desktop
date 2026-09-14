import { describe, expect, it } from 'vitest'
import { BUBBLE_MAX_CHARS, COLS, DRIVE_TO_STATE, FRAME_H, FRAME_W, PET_LAYOUT, bubbleLayout, frameAt } from './pet-layout.ts'

describe('pet-layout', () => {
  it('has the canonical rows and frame counts', () => {
    expect(PET_LAYOUT.idle).toEqual({ row: 0, frames: 6, loopMs: 1100 })
    expect(PET_LAYOUT.waving).toEqual({ row: 3, frames: 4, loopMs: 700 })
    expect(PET_LAYOUT.waiting.row).toBe(6)
    expect(PET_LAYOUT.running.row).toBe(7)
    expect(COLS).toBe(8)
  })

  it('maps the drive states main pushes to canonical rows', () => {
    expect(DRIVE_TO_STATE).toEqual({ idle: 'idle', running: 'running', waiting: 'waiting', wave: 'waving' })
  })

  it('frameAt returns frame 0 at t=0', () => {
    expect(frameAt('waving', 0)).toEqual({ sx: 0, sy: 3 * FRAME_H, sw: FRAME_W, sh: FRAME_H })
  })

  it('frameAt advances through frames and loops', () => {
    // waving: 4 frames over 700ms => 175ms per frame
    expect(frameAt('waving', 200).sx).toBe(1 * FRAME_W) // 2nd frame
    expect(frameAt('waving', 700).sx).toBe(0)           // loops back
    expect(frameAt('waving', 700 + 200).sx).toBe(1 * FRAME_W)
  })

  it('frameAt keeps frames within the row', () => {
    for (let t = 0; t < 5000; t += 37) {
      const f = frameAt('running', t)
      expect(f.sx).toBeGreaterThanOrEqual(0)
      expect(f.sx).toBeLessThan(COLS * FRAME_W)
      expect(f.sy).toBe(7 * FRAME_H)
    }
  })
})

describe('bubbleLayout', () => {
  it('sizes a rectangle that grows with short text but never exceeds maxWidthPx', () => {
    const short = bubbleLayout('Hi', 300)
    const longer = bubbleLayout('Reading something.ts', 300)
    expect(short.rectW).toBeLessThan(longer.rectW)
    expect(short.rectW).toBeLessThanOrEqual(300)
    expect(longer.rectW).toBeLessThanOrEqual(300)
    expect(short.text).toBe('Hi')
    expect(longer.text).toBe('Reading something.ts')
  })

  it('gives every bubble the same fixed height, independent of text length', () => {
    const a = bubbleLayout('x', 300)
    const b = bubbleLayout('a much longer line of bubble text here', 300)
    expect(a.rectH).toBe(b.rectH)
  })

  it('truncates text longer than BUBBLE_MAX_CHARS with an ellipsis', () => {
    const text = 'a'.repeat(BUBBLE_MAX_CHARS + 20)
    const { text: fitted } = bubbleLayout(text, 1000)
    expect(fitted.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS)
    expect(fitted.endsWith('…')).toBe(true)
  })

  it('further truncates when the text still overflows a narrow maxWidthPx', () => {
    const { text, rectW } = bubbleLayout('a fairly long line of bubble text', 60)
    expect(rectW).toBeLessThanOrEqual(60)
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBeLessThan('a fairly long line of bubble text'.length)
  })

  it('never returns a rectangle wider than maxWidthPx even for empty text', () => {
    const { rectW } = bubbleLayout('', 40)
    expect(rectW).toBeLessThanOrEqual(40)
  })

  it('clamps to at least one character of room even when maxWidthPx is tiny', () => {
    const { text, rectW } = bubbleLayout('hello there', 5)
    expect(text.length).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(rectW)).toBe(true)
  })
})
