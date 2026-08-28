import { describe, expect, it } from 'vitest'
import { keyEvent } from './browser-keys'

describe('keyEvent', () => {
  it('reads a named key with the code a page switches on', () => {
    expect(keyEvent('Enter')).toEqual({
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      modifiers: 0,
    })
  })

  it('gives a navigation key no text, since it inserts nothing', () => {
    expect(keyEvent('ArrowDown')?.text).toBeUndefined()
  })

  it('reads a printable character', () => {
    expect(keyEvent('a')).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
    expect(keyEvent('7')).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' })
  })

  it('reads modifiers as the protocol bitmask', () => {
    expect(keyEvent('Control+a')?.modifiers).toBe(2)
    expect(keyEvent('Meta+Shift+a')?.modifiers).toBe(12)
  })

  // reason: a shortcut that also typed its letter would leave the character
  // behind in whatever field had focus.
  it('gives a shortcut no text, but keeps it for a shifted character', () => {
    expect(keyEvent('Meta+a')?.text).toBeUndefined()
    expect(keyEvent('Shift+A')?.text).toBe('A')
  })

  // reason: a key event for one carries no character, so typing it would
  // insert nothing; the caller has to reach for text insertion instead.
  it('refuses a character no keyboard has a key for', () => {
    expect(keyEvent('\u2705')).toBeUndefined()
    expect(keyEvent('\u4e2d')).toBeUndefined()
  })

  it('refuses a name that is not a key', () => {
    expect(keyEvent('Retrun')).toBeUndefined()
    expect(keyEvent('Hyper+a')).toBeUndefined()
    expect(keyEvent('')).toBeUndefined()
  })
})
