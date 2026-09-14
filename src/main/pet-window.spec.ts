import { describe, expect, it } from 'vitest'
import { petComposePanelSize, petWindowSize } from './pet-window'

describe('petWindowSize', () => {
  it('scales the 192x208 frame plus the bubble band above it, and adds the fixed controls-row height', () => {
    expect(petWindowSize(1)).toEqual({ width: 192, height: 348 })
    expect(petWindowSize(1.5)).toEqual({ width: 288, height: 500 })
  })

  it('floors width at the controls-row minimum when the sprite is scaled down small', () => {
    expect(petWindowSize(0.25)).toEqual({ width: 96, height: 120 })
  })
})

describe('petComposePanelSize', () => {
  it('floors width at the panel minimum and swaps the controls-row band for the panel band, at the default scale', () => {
    expect(petComposePanelSize(1)).toEqual({ width: 380, height: 444 })
  })

  it('floors width at the panel minimum when the sprite is scaled down small', () => {
    expect(petComposePanelSize(0.5)).toEqual({ width: 380, height: 292 })
  })

  it('leaves width alone once the scaled sprite is already wider than the floor, replacing the controls-row band with the panel band in height', () => {
    expect(petComposePanelSize(2)).toEqual({ width: 384, height: 748 })
  })

  it('replaces the controls row rather than adding to it: at every scale the panel height equals the sprite region plus the panel band alone', () => {
    for (const scale of [0.5, 1, 1.5, 2]) {
      const sprite = petWindowSize(scale).height - 44 // CONTROLS_ROW_H, mirrored by hand
      expect(petComposePanelSize(scale).height).toBe(sprite + 140) // COMPOSE_PANEL_H, mirrored by hand
    }
  })
})
