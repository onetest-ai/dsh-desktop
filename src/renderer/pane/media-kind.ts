/** How a file is shown when it is opened. */
export type MediaKind = 'text' | 'image' | 'video' | 'audio' | 'pdf'

/** What each kind covers, by extension. */
const KINDS: Record<Exclude<MediaKind, 'text'>, Set<string>> = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']),
  video: new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']),
  audio: new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac']),
  pdf: new Set(['pdf']),
}

/**
 * How to show a file, by its name.
 *
 * By extension, like every other decision this pane makes before opening a
 * file: the name is all that is known. Anything unlisted is treated as text,
 * and the read itself refuses what turns out to be binary — a guess that a
 * file is text costs a message, while a guess that it is an image costs a
 * broken viewer.
 * @param name - the file's name or path.
 * @returns which viewer it belongs in.
 */
export function mediaKind(name: string): MediaKind {
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  for (const [kind, extensions] of Object.entries(KINDS)) {
    if (extensions.has(extension)) return kind as MediaKind
  }
  return 'text'
}

/**
 * Whether a file is shown as something other than text.
 * @param name - the file's name or path.
 * @returns whether it needs a media viewer.
 */
export function isMedia(name: string): boolean {
  return mediaKind(name) !== 'text'
}
