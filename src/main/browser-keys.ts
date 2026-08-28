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
  Insert: { code: 'Insert', keyCode: 45 },
}

/**
 * The punctuation keys of a US keyboard.
 *
 * Each row is the character the key types, the character it types with shift,
 * the `code` it reports, and its legacy key code.
 *
 * These are the values a real keyboard sends, and they are nothing like the
 * characters' own code points: a full stop is key 190, while its ASCII value,
 * 46, is the code for Delete. Sending the code point instead types nothing
 * and deletes the character to the right — which is what an address or a date
 * losing its punctuation looks like from the outside.
 */
const PUNCTUATION: [plain: string, shifted: string, code: string, keyCode: number][] = [
  [' ', ' ', 'Space', 32],
  [';', ':', 'Semicolon', 186],
  ['=', '+', 'Equal', 187],
  [',', '<', 'Comma', 188],
  ['-', '_', 'Minus', 189],
  ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192],
  ['[', '{', 'BracketLeft', 219],
  ['\\', '|', 'Backslash', 220],
  [']', '}', 'BracketRight', 221],
  ["'", '"', 'Quote', 222],
]

/** What each digit key types with shift held, indexed by the digit. */
const SHIFTED_DIGITS = ')!@#$%^&*('

/** Every printable character, with the key that types it. */
const PRINTABLE = new Map<string, { code: string; keyCode: number; shift: boolean }>()

for (let letter = 0; letter < 26; letter += 1) {
  const lower = String.fromCharCode(97 + letter)
  const upper = String.fromCharCode(65 + letter)
  PRINTABLE.set(lower, { code: `Key${upper}`, keyCode: 65 + letter, shift: false })
  PRINTABLE.set(upper, { code: `Key${upper}`, keyCode: 65 + letter, shift: true })
}
for (let digit = 0; digit < 10; digit += 1) {
  const key = { code: `Digit${String(digit)}`, keyCode: 48 + digit }
  PRINTABLE.set(String(digit), { ...key, shift: false })
  PRINTABLE.set(SHIFTED_DIGITS[digit], { ...key, shift: true })
}
for (const [plain, shifted, code, keyCode] of PUNCTUATION) {
  PRINTABLE.set(plain, { code, keyCode, shift: false })
  if (shifted !== plain) PRINTABLE.set(shifted, { code, keyCode, shift: true })
}

/** The character each key's `code` types, so a page's own spelling of a key is accepted. */
const BY_CODE = new Map<string, string>()
for (const [character, key] of PRINTABLE) {
  if (!key.shift && !BY_CODE.has(key.code)) BY_CODE.set(key.code, character)
}

/**
 * The editing commands a shortcut asks the browser to perform.
 *
 * A shortcut is not a page behaviour: `Meta+a` selects all because the
 * browser's editor acts on it, not because the page reads the key. Sending
 * only the key event presses it and nothing happens, which is what "select
 * all removed one character" looks like — the selection never existed and the
 * delete that followed acted on the caret.
 */
const COMMANDS: Record<string, string[]> = {
  a: ['selectAll'],
  c: ['copy'],
  v: ['paste'],
  x: ['cut'],
  z: ['undo'],
  y: ['redo'],
}

/**
 * The editing commands a key event should carry, if any.
 *
 * Read from the event rather than from the name so that `Control+a` and
 * `Meta+a` reach the same command, whichever the caller reached for.
 * @param event - the key event as `keyEvent` read it.
 * @returns the commands, or undefined when the key asks for none.
 */
export function editingCommands(event: KeyEvent): string[] | undefined {
  const held = event.modifiers & (MODIFIERS.Control | MODIFIERS.Meta)
  if (held === 0) return undefined
  const shifted = (event.modifiers & MODIFIERS.Shift) !== 0
  if (shifted && event.key.toLowerCase() === 'z') return ['redo']
  return COMMANDS[event.key.toLowerCase()]
}

/**
 * Read a key name, with any modifiers, into one key event.
 *
 * The name is written the way the DOM writes it — `Enter`, `ArrowDown`, `a`,
 * `.` — with modifiers joined by `+`, as in `Control+a`. A key's `code` is
 * accepted too, so `Period` reaches the same key as `.`: both spellings
 * appear in the DOM, and refusing one is a distinction with no purpose.
 *
 * A character that needs shift carries the shift modifier, because a page
 * reading `event.shiftKey` on a capital letter would otherwise see a
 * capital typed with no shift held.
 * @param name - the key, optionally prefixed with `Modifier+`.
 * @returns the event to dispatch, or undefined when the name is not a key.
 */
export function keyEvent(name: string): KeyEvent | undefined {
  if (name === '') return undefined
  const segments = name.split('+')
  // A trailing '+' is the plus key itself rather than an empty modifier, so
  // `+` and `Shift++` both name that key.
  const plus = segments.at(-1) === ''
  const key = plus ? '+' : (segments.at(-1) as string)
  let modifiers = 0
  for (const part of segments.slice(0, plus ? -2 : -1)) {
    const bit = MODIFIERS[part]
    if (bit === undefined) return undefined
    modifiers |= bit
  }
  const named = NAMED[key]
  if (named !== undefined) {
    return { key, code: named.code, windowsVirtualKeyCode: named.keyCode, text: named.text, modifiers }
  }
  const character = PRINTABLE.has(key) ? key : BY_CODE.get(key)
  if (character === undefined) return undefined
  const printable = PRINTABLE.get(character)
  if (printable === undefined) return undefined
  const held = modifiers | (printable.shift ? MODIFIERS.Shift : 0)
  return {
    key: character,
    code: printable.code,
    windowsVirtualKeyCode: printable.keyCode,
    // A key held with a modifier other than shift is a shortcut, not typing;
    // giving it text would insert the character as well as firing the
    // shortcut.
    text: (held & ~MODIFIERS.Shift) === 0 ? character : undefined,
    modifiers: held,
  }
}
