import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktop } from './desktop'

afterEach(() => {
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

describe('desktop', () => {
  it('reports the bridge when the desktop app put one there', () => {
    const bridge = { onAddToChat: vi.fn() }
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = bridge
    expect(desktop()).toBe(bridge)
  })

  // reason: this half is served to whatever page loads it, and only that page
  // knows whether it is running inside the desktop app.
  it.each([
    ['a plain browser, with nothing there', undefined],
    ['something that is not an object', 'yes'],
    ['an older desktop, with only the toggles', { toggleFiles: () => {}, toggleWeb: () => {} }],
  ])('reports nothing for %s', (_case, value) => {
    if (value !== undefined) (globalThis as { dshDesktop?: unknown }).dshDesktop = value
    expect(desktop()).toBeUndefined()
  })
})
