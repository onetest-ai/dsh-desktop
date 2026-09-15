import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { realpathAsFarAsExists, resolveInArch, resolveInWorkspace } from './paths.ts'

/**
 * Per-file cap. A pasted screenshot used as an "icon" is a real failure mode,
 * not a hypothetical one, and it lands in a repository everyone clones.
 */
export const MAX_ICON_BYTES = 262144

/** The four formats a browser renders reliably inside an `<img>`. */
export type IconMediaType = 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp'

/** An icon that cannot be accepted. */
export class IconError extends Error {
  /** @param message - the specific reason, fit to show the user. */
  constructor(message: string) {
    super(message)
    this.name = 'IconError'
  }
}

/** One available icon. */
export interface IconEntry {
  slug: string
  mediaType: IconMediaType
}

/**
 * Whether bytes start with a signature.
 * @param bytes - the file's leading bytes.
 * @param signature - the expected bytes.
 * @returns true on a match.
 */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

/**
 * Identify an icon from its content.
 *
 * Content, never the extension. A file named `.png` holding something else is
 * the ordinary shape of an image-parser attack, and the extension is the one
 * part of a file an attacker picks freely.
 * @param bytes - the file's contents.
 * @returns the media type, or undefined when unsupported.
 */
export function sniffMediaType(bytes: Uint8Array): IconMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp'
  }
  // SVG is text, so it has no byte signature — look for the root element near
  // the start, past any XML declaration or comment.
  const head = new TextDecoder().decode(bytes.subarray(0, 1024))
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return undefined
}

/**
 * Accept an icon, or say why not.
 * @param bytes - the file's contents.
 * @returns the media type.
 * @throws IconError when too large or of an unsupported format.
 */
export function admitIcon(bytes: Uint8Array): IconMediaType {
  if (bytes.byteLength > MAX_ICON_BYTES) {
    throw new IconError(`icon is too large: ${String(bytes.byteLength)} bytes, limit ${String(MAX_ICON_BYTES)}`)
  }
  const mediaType = sniffMediaType(bytes)
  if (mediaType === undefined) throw new IconError('unsupported image format — SVG, PNG, JPEG and WebP only')
  return mediaType
}

/**
 * Extra icon folders the project declares.
 *
 * Every entry passes `resolveInWorkspace`, so a config committed by someone
 * else cannot point the reader at `/etc`. A bad entry is dropped rather than
 * failing the whole config: one typo must not cost every icon.
 * @param project - the workspace root.
 * @returns declared paths, relative to the workspace root.
 */
export function readIconPaths(project: string): string[] {
  const config = resolveInArch(project, 'config.json')
  if (config === undefined) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(config, 'utf8'))
  } catch {
    // A hand-broken config must not take the plugin down with it.
    return []
  }
  if (typeof raw !== 'object' || raw === null) return []
  const paths = (raw as Record<string, unknown>)['iconPaths']
  if (!Array.isArray(paths)) return []
  return paths.filter((path): path is string => typeof path === 'string' && resolveInWorkspace(project, path) !== undefined)
}

/**
 * Walk a directory, yielding every file path beneath it.
 *
 * `fence` is the boundary nothing beneath may leave. Checking only the root is
 * not enough: `statSync` and `readdirSync` FOLLOW symlinks, so a link committed
 * under an icon folder — `icons/leak -> /etc` — is walked as though it were part
 * of the project, and every image-shaped file beneath it published as a slug a
 * later reader will happily fetch bytes for. Only a symlink can leave, so only a
 * symlink is resolved; ordinary entries under the fence cannot escape.
 * A symlink that stays INSIDE the fence is legitimate but can still loop:
 * `icons/self -> icons` is inside the project, so the fence check passes, and
 * the walk descended it until `statSync` hit ELOOP around sixteen levels down —
 * reporting one real icon as seventeen entries (`a`, `self/a`, `self/self/a`, …)
 * straight into an agent's context.
 *
 * `ancestors` is the chain of realpaths currently open, not every directory
 * seen: a directory that is its own ancestor is a cycle and stops here, while a
 * directory merely reachable by two different paths — `icons/shared -> icons/vendor`,
 * the legitimate aliasing case the tests below cover — is still walked under
 * both names. A single shared "visited" set would silently drop whichever of
 * the two `readdir` happened to return second.
 * @param dir - the directory to walk.
 * @param fence - the realpathed boundary; entries resolving outside are skipped.
 * @param ancestors - realpaths of the directories enclosing this one.
 * @returns absolute file paths inside the fence.
 */
function walk(dir: string, fence: string, ancestors: ReadonlySet<string> = new Set()): string[] {
  let entries: string[]
  let real: string
  try {
    if (!statSync(dir).isDirectory()) return []
    real = realpathAsFarAsExists(dir)
    if (ancestors.has(real)) return []
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const enclosing = new Set(ancestors).add(real)
  const files: string[] = []
  for (const entry of entries) {
    const at = join(dir, entry)
    let link: ReturnType<typeof lstatSync>
    try {
      link = lstatSync(at)
    } catch {
      continue
    }
    if (link.isSymbolicLink()) {
      const real = realpathAsFarAsExists(at)
      if (real !== fence && !real.startsWith(fence + sep)) continue
    }
    try {
      if (statSync(at).isDirectory()) files.push(...walk(at, fence, enclosing))
      else files.push(at)
    } catch {
      // A file that vanished between readdir and stat is simply not listed.
    }
  }
  return files
}

/**
 * Every icon available to this project, optionally filtered.
 *
 * The query is not optional in spirit: an icon pack runs to a thousand files,
 * and handing all of them to an agent at every call would flood its context.
 * Callers are expected to search.
 *
 * Subfolders namespace the slug (`icons/aws/ec2.svg` → `aws/ec2`) because
 * packs are hierarchical and collide otherwise.
 * @param project - the workspace root.
 * @param query - case-insensitive substring match on the slug.
 * @returns matching icons, sorted by slug.
 */
export function listIcons(project: string, query?: string): IconEntry[] {
  const roots: string[] = []
  // Through the fence, not join()'d: `.dsh/arch/icons` can itself be a symlink,
  // and an unchecked root starts the walk outside the project.
  const own = resolveInArch(project, 'icons')
  if (own !== undefined) roots.push(own)
  for (const declared of readIconPaths(project)) {
    const resolved = resolveInWorkspace(project, declared)
    if (resolved !== undefined) roots.push(resolved)
  }

  // The boundary is the WORKSPACE, not the icon folder. `iconPaths` already
  // lets a project name `docs/icons`, so a symlink from inside icons/ to
  // another folder in the same project is the same statement by another
  // spelling — only leaving the project is an escape.
  const fence = realpathAsFarAsExists(project)

  const found = new Map<string, IconEntry>()
  for (const root of roots) {
    for (const file of walk(root, fence)) {
      let bytes: Uint8Array
      try {
        bytes = readFileSync(file)
      } catch {
        continue
      }
      const mediaType = sniffMediaType(bytes)
      if (mediaType === undefined) continue
      const withoutExtension = relative(root, file).replace(/\.[^.]+$/, '')
      const slug = withoutExtension.split(sep).join('/')
      // First root wins, so the project's own icons/ shadows a declared path.
      if (!found.has(slug)) found.set(slug, { slug, mediaType })
    }
  }

  const needle = query?.toLowerCase()
  return [...found.values()]
    .filter((icon) => needle === undefined || icon.slug.toLowerCase().includes(needle))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}
