import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js'

/** Where the vendored icons are served from. */
const ICONS = 'icons'

/** What the tree falls back to for a file type this app did not vendor an icon for. */
const FALLBACK = 'default_file.svg'

/** The plain folder, which the tree uses open or closed. */
const FOLDER = 'default_folder.svg'

/**
 * The folder icon vscode-icons draws for an expanded folder with no type of
 * its own.
 *
 * A hollow outline, which at sixteen pixels reads as an empty box beside the
 * solid folder above it. The twisty already says whether a folder is open, so
 * nothing is lost by drawing the legible one in both states — while a folder
 * that does have a type keeps its own opened icon, which is drawn solid.
 */
const HOLLOW_OPEN_FOLDER = 'default_folder_opened.svg'

/**
 * File types vscode-icons has no icon for, and the name to borrow one from.
 *
 * Only where the borrowed icon is the honest answer: JSON Lines is JSON, one
 * object per line, and a reader scanning the tree gains nothing from it being
 * the only unmarked file among its neighbours.
 */
const BORROWED: Record<string, string> = {
  jsonl: 'json',
  ndjson: 'json',
}

/**
 * The name whose icon an entry should use.
 * @param name - the entry's name.
 * @returns the name to look the icon up by.
 */
function lookupName(name: string): string {
  // A dot after the first character: `jsonl` is a file called jsonl, and
  // `.jsonl` is a dotfile, neither of which has that extension.
  const dot = name.lastIndexOf('.')
  if (dot < 1) return name
  const borrowed = BORROWED[name.slice(dot + 1).toLowerCase()]
  return borrowed === undefined ? name : `${name.slice(0, dot + 1)}${borrowed}`
}

/**
 * The icon file for one entry in the tree.
 *
 * The mapping is vscode-icons', so a `.ts` file gets the icon a VS Code user
 * already reads as TypeScript. Deliberately not the harness's icon set: that
 * is a monochrome UI vocabulary with no per-language glyphs in it, and a tree
 * is read by extension at a glance.
 *
 * Two departures from that mapping, both about legibility rather than taste:
 * a file type it does not know may borrow a related type's icon, and a plain
 * expanded folder keeps the solid folder rather than the hollow outline.
 * @param name - the entry's name.
 * @param directory - whether it is a directory.
 * @param open - whether that directory is expanded.
 * @returns the icon's file name.
 */
export function iconFileFor(name: string, directory: boolean, open = false): string {
  if (!directory) return getIconForFile(lookupName(name)) ?? FALLBACK
  if (!open) return getIconForFolder(name)
  const opened = getIconForOpenFolder(name)
  return opened === HOLLOW_OPEN_FOLDER ? FOLDER : opened
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
