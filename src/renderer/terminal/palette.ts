/** The colours xterm draws with, read from the harness's own tokens. */
export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

/**
 * Read the panel's palette out of the vendored tokens.
 *
 * From the live computed style rather than a table of hex values: the token
 * sheet is the one place the harness's colours are stated, and a second copy
 * here would drift from it the first time either theme changed.
 * @param element - the element the tokens are in scope on.
 * @param read - reads a computed property; injected for tests.
 * @returns the palette, with any token that resolves to nothing left out so
 *   xterm falls back to its own default rather than drawing with `''`.
 */
export function palette(
  element: Element,
  read: (element: Element, property: string) => string = (target, property) =>
    getComputedStyle(target).getPropertyValue(property).trim(),
): Partial<TerminalPalette> {
  const token = (name: string): string | undefined => {
    const value = read(element, name)
    return value === '' ? undefined : value
  }
  const entries: [keyof TerminalPalette, string | undefined][] = [
    ['background', token('--dsw-alias-bg-base')],
    ['foreground', token('--dsw-alias-label-primary')],
    ['cursor', token('--dsw-alias-label-primary')],
    ['selectionBackground', token('--dsw-alias-interactive-bg-hover-solid')],
  ]
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined))
}
