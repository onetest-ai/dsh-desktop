import { describe, expect, it } from 'vitest'
import { petComposePanelSize, petWindowSize } from './pet-window'

describe('petWindowSize', () => {
  it('scales the 192x208 frame plus the bubble band above it', () => {
    expect(petWindowSize(1)).toEqual({ width: 192, height: 304 })
    expect(petWindowSize(1.5)).toEqual({ width: 288, height: 456 })
  })
})

describe('petComposePanelSize', () => {
  it('floors width at the panel minimum and grows height by the panel band, at the default scale', () => {
    expect(petComposePanelSize(1)).toEqual({ width: 200, height: 344 })
  })

  it('floors width at the panel minimum when the sprite is scaled down small', () => {
    expect(petComposePanelSize(0.5)).toEqual({ width: 200, height: 192 })
  })

  it('leaves width alone once the scaled sprite is already wider than the floor, still adding the panel band to height', () => {
    const base = petWindowSize(2)
    expect(petComposePanelSize(2)).toEqual({ width: base.width, height: base.height + 40 })
  })
})
