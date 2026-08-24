import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dumpDeclaredPatchRow, loadDeclaredPatchRows } from './bundle-patch'

/**
 * Write a declared patch file's own text into a fresh temp package directory.
 * @param text - the patch file's raw contents.
 * @returns the package directory `loadDeclaredPatchRows` should read from.
 */
function packageWithPatch(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundle-patch-'))
  writeFileSync(join(dir, 'cordis.patch.yml'), text)
  return dir
}

describe('loadDeclaredPatchRows', () => {
  it("parses a package's own insert row, id/name/config included", () => {
    const dir = packageWithPatch(`
- insert:
    - id: deck
      name: '@onetest/dsh-deck'
      config:
        base: /deck
`)
    const rows = loadDeclaredPatchRows(dir, 'cordis.patch.yml')
    expect(rows).toEqual([{ id: 'deck', name: '@onetest/dsh-deck', config: { base: '/deck' } }])
  })

  it('parses more than one insert row from the same patch file', () => {
    const dir = packageWithPatch(`
- insert:
    - id: deck
      name: '@onetest/dsh-deck'
    - id: deck-companion
      name: '@onetest/dsh-deck-companion'
`)
    const rows = loadDeclaredPatchRows(dir, 'cordis.patch.yml')
    expect(rows).toEqual([
      { id: 'deck', name: '@onetest/dsh-deck' },
      { id: 'deck-companion', name: '@onetest/dsh-deck-companion' },
    ])
  })

  it('skips a top-level entry with no insert key rather than treating it as malformed', () => {
    const dir = packageWithPatch(`
- id: some-other-row
  disabled: true
- insert:
    - id: deck
      name: '@onetest/dsh-deck'
`)
    const rows = loadDeclaredPatchRows(dir, 'cordis.patch.yml')
    expect(rows).toEqual([{ id: 'deck', name: '@onetest/dsh-deck' }])
  })

  it('is undefined, not throwing, when the declared file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundle-patch-'))
    expect(loadDeclaredPatchRows(dir, 'cordis.patch.yml')).toBeUndefined()
  })

  it('is undefined, not throwing, for malformed YAML', () => {
    const dir = packageWithPatch('- insert: [ this is not valid yaml: [')
    expect(loadDeclaredPatchRows(dir, 'cordis.patch.yml')).toBeUndefined()
  })

  it('is undefined for a document that does not parse to a top-level array', () => {
    const dir = packageWithPatch('insert:\n  - id: deck\n    name: x\n')
    expect(loadDeclaredPatchRows(dir, 'cordis.patch.yml')).toBeUndefined()
  })

  it('is undefined when an insert value is not itself an array', () => {
    const dir = packageWithPatch('- insert: not-an-array\n')
    expect(loadDeclaredPatchRows(dir, 'cordis.patch.yml')).toBeUndefined()
  })

  it('is undefined when a row is missing a string id or name', () => {
    const dir = packageWithPatch('- insert:\n    - name: x\n')
    expect(loadDeclaredPatchRows(dir, 'cordis.patch.yml')).toBeUndefined()
  })

  it('is undefined when the insert list is empty', () => {
    const dir = packageWithPatch('- insert: []\n')
    expect(loadDeclaredPatchRows(dir, 'cordis.patch.yml')).toBeUndefined()
  })
})

describe('dumpDeclaredPatchRow', () => {
  it('nests the row under a 4-space list item with 6-space continuations', () => {
    const text = dumpDeclaredPatchRow({ id: 'deck', name: '@onetest/dsh-deck', config: { base: '/deck' } })
    expect(text).toBe('    - id: deck\n      name: \'@onetest/dsh-deck\'\n      config:\n        base: /deck\n')
  })
})
