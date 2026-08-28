import { describe, expect, it } from 'vitest'
import { editingCommands, keyEvent } from './browser-keys'

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

  it('reads a letter', () => {
    expect(keyEvent('a')).toEqual({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', modifiers: 0 })
  })

  it('reads a digit', () => {
    expect(keyEvent('7')).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' })
  })

  // reason: a key code taken from the character's own value collides with the
  // codes for editing keys — a full stop's is 46, which is Delete. Typing an
  // address or a date then loses its punctuation and eats the text after it.
  it('reads punctuation as the key that types it, not as its character code', () => {
    expect(keyEvent('.')).toEqual({
      key: '.',
      code: 'Period',
      windowsVirtualKeyCode: 190,
      text: '.',
      modifiers: 0,
    })
    expect(keyEvent('-')).toMatchObject({ code: 'Minus', windowsVirtualKeyCode: 189 })
    expect(keyEvent('/')).toMatchObject({ code: 'Slash', windowsVirtualKeyCode: 191 })
    expect(keyEvent(',')).toMatchObject({ code: 'Comma', windowsVirtualKeyCode: 188 })
  })

  it('never gives a printable character the code of an editing key', () => {
    const editing = new Set([8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46])
    for (const character of ' !"#$%&\'()*+,-./0189:;<=>?@AZ[\\]^_`az{|}~') {
      const event = keyEvent(character)
      expect(event, character).toBeDefined()
      expect(editing.has(event?.windowsVirtualKeyCode ?? 0), `${character} maps to an editing key`).toBe(false)
      expect(event?.text, character).toBe(character)
    }
  })

  // reason: a page reading `event.shiftKey` would otherwise see a capital
  // letter typed with no shift held.
  it('holds shift for a character that needs it', () => {
    expect(keyEvent('A')).toEqual({ key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'A', modifiers: 8 })
    expect(keyEvent('@')).toMatchObject({ code: 'Digit2', text: '@', modifiers: 8 })
    expect(keyEvent(':')).toMatchObject({ code: 'Semicolon', text: ':', modifiers: 8 })
  })

  it('reads modifiers as the protocol bitmask', () => {
    expect(keyEvent('Control+a')?.modifiers).toBe(2)
    expect(keyEvent('Meta+Shift+a')?.modifiers).toBe(12)
  })

  it('reads the plus key itself, with or without a modifier', () => {
    expect(keyEvent('+')).toMatchObject({ code: 'Equal', text: '+', modifiers: 8 })
    expect(keyEvent('Control++')).toMatchObject({ code: 'Equal', modifiers: 10 })
  })

  // reason: a shortcut that also typed its letter would leave the character
  // behind in whatever field had focus.
  it('gives a shortcut no text, but keeps it for a shifted character', () => {
    expect(keyEvent('Meta+a')?.text).toBeUndefined()
    expect(keyEvent('Shift+A')?.text).toBe('A')
  })

  // reason: both spellings appear in the DOM, and an agent reaching for the
  // one this refused has no way to tell which it wanted.
  it("accepts a key's own code as its name", () => {
    expect(keyEvent('Period')).toEqual(keyEvent('.'))
    expect(keyEvent('Slash')).toEqual(keyEvent('/'))
    expect(keyEvent('KeyA')).toEqual(keyEvent('a'))
    expect(keyEvent('Digit3')).toEqual(keyEvent('3'))
  })

  // reason: a key event for one carries no character, so typing it would
  // insert nothing; the caller has to reach for text insertion instead.
  it('refuses a character no keyboard has a key for', () => {
    expect(keyEvent('✅')).toBeUndefined()
    expect(keyEvent('中')).toBeUndefined()
  })

  it('refuses a name that is not a key', () => {
    expect(keyEvent('Retrun')).toBeUndefined()
    expect(keyEvent('Hyper+a')).toBeUndefined()
    expect(keyEvent('')).toBeUndefined()
  })
})

describe('editingCommands', () => {
  // reason: select-all is the browser's editor acting, not the page reading a
  // key. Sending only the key press selects nothing, and the delete that
  // follows removes one character — which is exactly what was reported.
  it('asks the browser to select all for the shortcut that means it', () => {
    expect(editingCommands(keyEvent('Meta+a') as never)).toEqual(['selectAll'])
    expect(editingCommands(keyEvent('Control+a') as never)).toEqual(['selectAll'])
  })

  it('covers the other editing shortcuts', () => {
    expect(editingCommands(keyEvent('Meta+c') as never)).toEqual(['copy'])
    expect(editingCommands(keyEvent('Meta+v') as never)).toEqual(['paste'])
    expect(editingCommands(keyEvent('Meta+x') as never)).toEqual(['cut'])
    expect(editingCommands(keyEvent('Meta+z') as never)).toEqual(['undo'])
    expect(editingCommands(keyEvent('Meta+Shift+z') as never)).toEqual(['redo'])
  })

  it('asks for nothing when no shortcut is held', () => {
    expect(editingCommands(keyEvent('a') as never)).toBeUndefined()
    expect(editingCommands(keyEvent('Shift+a') as never)).toBeUndefined()
    expect(editingCommands(keyEvent('Meta+q') as never)).toBeUndefined()
  })
})
