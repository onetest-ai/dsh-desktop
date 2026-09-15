import { describe, expect, it } from 'vitest'
import { apply } from './index'

describe('apply', () => {
  it('is a cordis plugin body', () => {
    expect(typeof apply).toBe('function')
  })
})
