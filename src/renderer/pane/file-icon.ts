import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js'

/** Where the vendored icons are served from. */
const ICONS = 'icons'

/** What the tree falls back to for a file type this app did not vendor an icon for. */
const FALLBACK = 'default_file.svg'

/**
 * The icon file for one entry in the tree.
 *
 * The mapping is vscode-icons', so a `.ts` file gets the icon a VS Code user
 * already reads as TypeScript. Deliberately not the harness's icon set: that
 * is a monochrome UI vocabulary with no per-language glyphs in it, and a tree
 * is read by extension at a glance.
 * @param name - the entry's name.
 * @param directory - whether it is a directory.
 * @param open - whether that directory is expanded.
 * @returns the icon's file name.
 */
export function iconFileFor(name: string, directory: boolean, open = false): string {
  if (directory) return open ? getIconForOpenFolder(name) : getIconForFolder(name)
  return getIconForFile(name) ?? FALLBACK
}

/**
 * An `<img>` showing one entry's icon.
 *
 * Served as files rather than inlined: the set is a few dozen SVGs, and an
 * image the page loads by URL is cached once instead of rebuilt per row.
 *
 * A file type whose icon was never vendored falls back rather than showing a
 * broken image — the mapping knows more file types than this app carries
 * icons for, and that gap is expected to exist.
 * @param name - the entry's name.
 * @param directory - whether it is a directory.
 * @param open - whether that directory is expanded.
 * @returns the image element.
 */
export function fileIcon(name: string, directory: boolean, open = false): HTMLImageElement {
  const image = document.createElement('img')
  image.className = 'file-icon'
  image.width = 16
  image.height = 16
  image.alt = ''
  image.src = `${ICONS}/${iconFileFor(name, directory, open)}`
  image.addEventListener('error', () => {
    if (!image.src.endsWith(FALLBACK)) image.src = `${ICONS}/${FALLBACK}`
  })
  return image
}
