/**
 * Which files the editor offers to open in the Web tab.
 *
 * The pane-side mirror of main's `web-page.ts` (`isWebPage` there): the two are
 * deliberately re-declared rather than shared across the main/renderer compile
 * boundary. Only a live page is worth the Web tab — an image, video, or PDF
 * already opens in its own editor tab, and anything else the view would show
 * as source or refuse. Kept in step with main's list by hand.
 */
const PAGES = new Set(['html', 'htm'])

/**
 * Whether the Web tab can show this file as a rendered page.
 * @param name - the file's name or path.
 * @returns whether the "Open in Web" affordance applies to it.
 */
export function isWebPage(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && PAGES.has(name.slice(dot + 1).toLowerCase())
}
