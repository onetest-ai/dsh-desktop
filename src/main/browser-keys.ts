/** One key press, in the fields `Input.dispatchKeyEvent` names. */
export interface KeyEvent {
  /** The `KeyboardEvent.key` value the page sees. */
  key: string
  /** The `KeyboardEvent.code` value the page sees. */
  code: string
  /** The legacy key code, which older page scripts still switch on. */
  windowsVirtualKeyCode: number
  /** The character the key inserts, absent for keys that insert nothing. */
  text?: string
  /** The held modifiers, as the protocol's bitmask. */
  modifiers: number
}

/**
 * The protocol's modifier bits.
 *
 * Fixed by the DevTools protocol, not a tunable.
 */
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

/** The named keys a page is likely to be waiting for, with their legacy codes. */
const NAMED: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
}

/**
 * Read a key name, with any modifiers, into one key event.
 *
 * The name is written the way the DOM writes it — `Enter`, `ArrowDown`, `a` —
 * with modifiers joined by `+`, as in `Control+a`. That is the spelling the
 * model already knows from every other browser tool, so it is the one this
 * accepts.
 * @param name - the key, optionally prefixed with `Modifier+`.
 * @returns the event to dispatch, or undefined when the name is not a key.
 */
export function keyEvent(name: string): KeyEvent | undefined {
  const parts = name.split('+')
  const key = parts.pop() ?? ''
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIERS[part]
    if (bit === undefined) return undefined
    modifiers |= bit
  }
  const named = NAMED[key]
  if (named !== undefined) {
    return { key, code: named.code, windowsVirtualKeyCode: named.keyCode, text: named.text, modifiers }
  }
  // Only a key a keyboard has: an emoji or a CJK glyph has no key code or
  // `code` to report, and a key event carrying neither inserts nothing. The
  // caller inserts those as text instead.
  if (key.length !== 1 || key < ' ' || key > '~') return undefined
  const upper = key.toUpperCase()
  return {
    key,
    code: /[a-z]/i.test(key) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : '',
    windowsVirtualKeyCode: upper.charCodeAt(0),
    // A key held with a non-shift modifier is a shortcut, not typing; giving
    // it text would insert the character as well as firing the shortcut.
    text: modifiers === 0 || modifiers === MODIFIERS.Shift ? key : undefined,
    modifiers,
  }
}
