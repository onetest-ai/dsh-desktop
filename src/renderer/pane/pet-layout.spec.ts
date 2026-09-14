import { describe, expect, it } from 'vitest'
import { COLS, FRAME_H, FRAME_W, PET_LAYOUT, DRIVE_TO_STATE, frameAt } from './pet-layout.ts'

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
