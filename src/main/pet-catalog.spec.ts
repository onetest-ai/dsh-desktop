import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listInstalledPets, loadPetSprite } from './pet-catalog'

describe('pet-catalog', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'petdex-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const writePet = (slug: string, json: unknown, sheet = 'spritesheet.webp') => {
    const d = join(dir, slug)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'pet.json'), JSON.stringify(json))
    if (sheet) writeFileSync(join(d, sheet), Buffer.from([0x52, 0x49, 0x46, 0x46]))
  }

  it('lists valid installed pets', () => {
    writePet('boba', { id: 'boba', displayName: 'Boba', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' })
    const pets = listInstalledPets(dir)
    expect(pets).toHaveLength(1)
    expect(pets[0]).toMatchObject({ slug: 'boba', name: 'Boba', spriteVersion: 2 })
    expect(pets[0].spritesheetPath).toContain(join('boba', 'spritesheet.webp'))
  })

  it('skips a pet whose spritesheet is missing', () => {
    writePet('broken', { id: 'broken', displayName: 'Broken', spritesheetPath: 'spritesheet.webp' }, '')
    expect(listInstalledPets(dir)).toEqual([])
  })

  it('skips a pet with unparseable pet.json', () => {
    const d = join(dir, 'bad')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'pet.json'), '{ not json')
    expect(listInstalledPets(dir)).toEqual([])
  })

  it('returns [] when the pets dir does not exist', () => {
    expect(listInstalledPets(join(dir, 'nope'))).toEqual([])
  })

  it('loadPetSprite returns a data URL', () => {
    writePet('boba', { id: 'boba', displayName: 'Boba', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' })
    const url = loadPetSprite(listInstalledPets(dir)[0])
    expect(url.startsWith('data:image/webp;base64,')).toBe(true)
  })
})
