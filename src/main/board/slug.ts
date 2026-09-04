/**
 * Filesystem-safe slug from a display name.
 *
 * The fallback matters more than it looks: a name that is entirely
 * non-latin — a Cyrillic or CJK title — reduces to the empty string, and an
 * empty folder name is not a name. Upstream fell back to a random id; this
 * derives one from the name's own bytes instead, so the same name always
 * yields the same folder and a re-run does not scatter duplicates.
 * @param name - the display name.
 * @returns a slug safe to use as a directory name, never empty.
 */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '')
  if (s !== '') return s
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return `entity-${hash.toString(16).padStart(8, '0')}`
}

/**
 * The first slug in `base`, `base-2`, `base-3`, … not already in `taken`.
 * @param base - the slug a name naturally produces.
 * @param taken - slugs already in use in the same directory.
 * @returns `base` itself if free, else the first numbered variant that is.
 */
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
