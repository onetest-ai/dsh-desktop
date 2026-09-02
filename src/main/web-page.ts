/**
 * The extensions the web view can render as a page.
 *
 * Deliberately short. An image, a PDF, and a video already open in a tab of
 * their own in the editor column, so routing them here would give the same
 * file two ways to be looked at; anything else the view would show as source
 * or refuse outright, and a menu entry that does nothing is worse than none.
 */
const PAGES = new Set(['html', 'htm'])

/**
 * Whether the web view can show this file as a rendered page.
 * @param name - the file's name or path.
 * @returns whether Open in Web applies to it.
 */
export function isWebPage(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && PAGES.has(name.slice(dot + 1).toLowerCase())
}
