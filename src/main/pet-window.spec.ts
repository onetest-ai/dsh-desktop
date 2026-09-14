import { describe, expect, it } from 'vitest'
import { petWindowSize } from './pet-window'

describe('petWindowSize', () => {
  it('scales the 192x208 frame', () => {
    expect(petWindowSize(1)).toEqual({ width: 192, height: 208 })
    expect(petWindowSize(1.5)).toEqual({ width: 288, height: 312 })
  })
})
