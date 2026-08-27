import { GLYPHS } from './icons.ts'

/** Which glyph a file gets, by what the name says it is. */
export type FileGlyph = keyof typeof GLYPHS

/**
 * Extensions that get the code glyph.
 *
 * Kept to what this editor actually highlights. Everything unlisted takes no
 * glyph at all rather than a guess: a wrong icon is worse than none, because
 * it is read as information about a file the app has not opened.
 */
const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'html', 'htm', 'css', 'scss', 'less', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish',
  'vue', 'svelte', 'graphql',
])

/** Extensions that carry structured data rather than code or prose. */
const DATA = new Set(['json', 'jsonc', 'jsonl', 'yml', 'yaml', 'toml', 'xml', 'csv', 'tsv', 'sql', 'ndjson'])

/** Extensions rendered as prose. */
const DOCUMENT = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'log'])

/**
 * The glyph for one entry in the tree, or undefined when none fits.
 *
 * By extension, like the editor's language choice, and for the same reason:
 * the name is all that is known before the file is opened. The glyphs are the
 * harness's own, so a folder here is the folder it would have drawn.
 * @param name - the entry's name.
 * @param directory - whether it is a directory.
 * @param open - whether that directory is expanded.
 * @returns the glyph to draw, or undefined to draw none.
 */
export function fileGlyph(name: string, directory: boolean, open = false): FileGlyph | undefined {
  if (directory) return open ? 'folderOpen' : 'folderClosed'
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  if (CODE.has(extension)) return 'code'
  if (DATA.has(extension)) return 'data'
  if (DOCUMENT.has(extension)) return 'document'
  return undefined
}
