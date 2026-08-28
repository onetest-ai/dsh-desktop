import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteEntry, pasteEntry, renameEntry } from './file-ops'

/** A project with a folder, a nested file, and a file at the root. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ops-'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'code')
  writeFileSync(join(root, 'notes.md'), 'notes')
  return root
}

describe('renameEntry', () => {
  it('renames a file where it is', () => {
    const root = project()
    expect(renameEntry(root, 'src/index.ts', 'main.ts')).toEqual({ ok: true, relative: 'src/main.ts' })
    expect(readFileSync(join(root, 'src', 'main.ts'), 'utf8')).toBe('code')
  })

  it('renames a file at the project root', () => {
    const root = project()
    expect(renameEntry(root, 'notes.md', 'readme.md')).toEqual({ ok: true, relative: 'readme.md' })
  })

  it('renames a folder with everything in it', () => {
    const root = project()
    expect(renameEntry(root, 'src', 'lib').ok).toBe(true)
    expect(existsSync(join(root, 'lib', 'index.ts'))).toBe(true)
  })

  // reason: these names come from the renderer, and a rename that can write
  // `../` is a rename that can leave the project.
  it.each([
    ['a traversal', '../escaped.md'],
    ['a path', 'other/escaped.md'],
    ['nothing', ''],
    ['a dot', '.'],
    ['a double dot', '..'],
  ])('refuses %s as a new name', (_case, name) => {
    const root = project()
    expect(renameEntry(root, 'notes.md', name).ok).toBe(false)
    expect(existsSync(join(root, 'notes.md'))).toBe(true)
  })

  it('refuses a name already taken, rather than replacing it', () => {
    const root = project()
    writeFileSync(join(root, 'taken.md'), 'mine')
    expect(renameEntry(root, 'notes.md', 'taken.md').ok).toBe(false)
    expect(readFileSync(join(root, 'taken.md'), 'utf8')).toBe('mine')
  })

  it('refuses an entry outside the project', () => {
    expect(renameEntry(project(), '../elsewhere', 'x').ok).toBe(false)
  })
})

describe('deleteEntry', () => {
  it('deletes a file', () => {
    const root = project()
    expect(deleteEntry(root, 'notes.md')).toEqual({ ok: true, relative: 'notes.md' })
    expect(existsSync(join(root, 'notes.md'))).toBe(false)
  })

  it('deletes a folder and what is inside it', () => {
    const root = project()
    expect(deleteEntry(root, 'src').ok).toBe(true)
    expect(existsSync(join(root, 'src'))).toBe(false)
  })

  // reason: an operation that empties the project is not one a context menu
  // should be able to reach.
  it('refuses the project itself', () => {
    const root = project()
    expect(deleteEntry(root, '')).toEqual({ ok: false, reason: 'That is the project itself.' })
    expect(existsSync(root)).toBe(true)
  })

  it('refuses an entry outside the project', () => {
    const outside = project()
    const root = project()
    symlinkSync(join(outside, 'notes.md'), join(root, 'link.md'))
    expect(deleteEntry(root, 'link.md').ok).toBe(false)
    expect(existsSync(join(outside, 'notes.md'))).toBe(true)
  })

  it('reports a delete it could not make', () => {
    expect(deleteEntry(project(), 'missing.md').ok).toBe(false)
  })
})

describe('pasteEntry', () => {
  it('copies a file into a folder, leaving the original', () => {
    const root = project()
    expect(pasteEntry(root, 'notes.md', 'src', false)).toEqual({ ok: true, relative: 'src/notes.md' })
    expect(existsSync(join(root, 'notes.md'))).toBe(true)
    expect(readFileSync(join(root, 'src', 'notes.md'), 'utf8')).toBe('notes')
  })

  it('moves a file, taking the original with it', () => {
    const root = project()
    expect(pasteEntry(root, 'notes.md', 'src', true).ok).toBe(true)
    expect(existsSync(join(root, 'notes.md'))).toBe(false)
    expect(existsSync(join(root, 'src', 'notes.md'))).toBe(true)
  })

  it('copies a folder with everything in it', () => {
    const root = project()
    mkdirSync(join(root, 'dest'))
    expect(pasteEntry(root, 'src', 'dest', false).ok).toBe(true)
    expect(existsSync(join(root, 'dest', 'src', 'index.ts'))).toBe(true)
  })

  // reason: pasting beside the original is the common case, and losing what
  // is already there would be the worst possible answer.
  it('suffixes rather than overwriting when the name is taken', () => {
    const root = project()
    expect(pasteEntry(root, 'notes.md', '', false)).toEqual({ ok: true, relative: 'notes copy.md' })
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('notes')
    expect(pasteEntry(root, 'notes.md', '', false)).toEqual({ ok: true, relative: 'notes copy 2.md' })
  })

  it('keeps the extension, so a copy still opens as what it is', () => {
    const root = project()
    const result = pasteEntry(root, 'notes.md', '', false)
    expect(result.ok && result.relative.endsWith('.md')).toBe(true)
  })

  // reason: moving takes the destination with it, and copying recurses
  // forever — so both refuse, rather than one surfacing an fs error.
  it.each([
    ['moved', true],
    ['copied', false],
  ])('refuses a folder being %s into itself or below it', (_case, move) => {
    const root = project()
    expect(pasteEntry(root, 'src', 'src', move).ok).toBe(false)
    expect(pasteEntry(root, 'src', 'src/deep', move).ok).toBe(false)
    expect(existsSync(join(root, 'src', 'index.ts'))).toBe(true)
  })

  it('refuses a destination that is a file', () => {
    expect(pasteEntry(project(), 'src', 'notes.md', false)).toEqual({ ok: false, reason: 'That is not a folder.' })
  })

  it.each([
    ['a source outside the project', '../elsewhere', 'src'],
    ['a destination outside the project', 'notes.md', '../elsewhere'],
  ])('refuses %s', (_case, from, into) => {
    expect(pasteEntry(project(), from, into, false).ok).toBe(false)
  })

  it('pastes into the project root', () => {
    const root = project()
    expect(pasteEntry(root, 'src/index.ts', '', false)).toEqual({ ok: true, relative: 'index.ts' })
    expect(statSync(join(root, 'index.ts')).isFile()).toBe(true)
  })
})
