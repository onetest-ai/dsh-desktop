import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

/** Petdex atlas geometry — see PET_LAYOUT (renderer). Frames are 192×208, 8 wide. */
export const PET_FRAME = { w: 192, h: 208 } as const
export const PET_COLS = 8

export interface PetMeta {
  slug: string
  name: string
  spriteVersion: 1 | 2
  /** Absolute path to the spritesheet file. */
  spritesheetPath: string
}

/** Where the `petdex` CLI installs pets. */
export function defaultPetsDir(): string {
  return join(homedir(), '.petdex', 'pets')
}

/**
 * Every pet installed under `petsDir`, newest Petdex format or old.
 *
 * A pet whose `pet.json` is missing/unparseable or whose spritesheet is absent
 * is skipped, not fatal: a half-written or hand-edited pack must never take the
 * whole catalog (or the app) down. Read errors on the directory itself yield an
 * empty list — "no pets installed" is a normal, expected state.
 */
export function listInstalledPets(petsDir: string = defaultPetsDir()): PetMeta[] {
  let entries: string[]
  try {
    entries = readdirSync(petsDir)
  } catch {
    return []
  }
  const pets: PetMeta[] = []
  for (const slug of entries) {
    const dir = join(petsDir, slug)
    try {
      if (!statSync(dir).isDirectory()) continue
      const raw = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8')) as {
        displayName?: unknown
        spriteVersionNumber?: unknown
        spritesheetPath?: unknown
      }
      const sheetName = typeof raw.spritesheetPath === 'string' ? raw.spritesheetPath : 'spritesheet.webp'
      const spritesheetPath = join(dir, sheetName)
      statSync(spritesheetPath) // throws if absent -> skip
      pets.push({
        slug,
        name: typeof raw.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : slug,
        spriteVersion: raw.spriteVersionNumber === 2 ? 2 : 1,
        spritesheetPath,
      })
    } catch (cause) {
      console.warn(`[pet] skipping unreadable pet "${slug}":`, cause instanceof Error ? cause.message : cause)
    }
  }
  return pets.sort((a, b) => a.name.localeCompare(b.name))
}

/** The spritesheet as a data URL — pets live outside `dist`, so no app:// path serves them. */
export function loadPetSprite(meta: PetMeta): string {
  const mime = extname(meta.spritesheetPath).toLowerCase() === '.png' ? 'image/png' : 'image/webp'
  return `data:${mime};base64,${readFileSync(meta.spritesheetPath).toString('base64')}`
}
