import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFile, createFolder, creationParent } from './file-create'

/** A project directory with a `src` folder and a file in it. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-create-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'index.ts'), 'x')
  return root
}

describe('createFile', () => {
  it('creates an empty file at the project root', () => {
    const root = project()
    expect(createFile(root, 'notes.md')).toEqual({ ok: true, relative: 'notes.md' })
    expect(existsSync(join(root, 'notes.md'))).toBe(true)
  })

  it('creates one inside a folder that exists', () => {
    const root = project()
    expect(createFile(root, 'src/new.ts').ok).toBe(true)
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(true)
  })

  // reason: a typo should not silently replace work.
  it('refuses a name already taken', () => {
    const root = project()
    expect(createFile(root, 'src/index.ts')).toEqual({
      ok: false,
      reason: 'Something with that name is already there.',
    })
    expect(statSync(join(root, 'src', 'index.ts')).size).toBe(1)
  })

  // reason: these arrive from the renderer, and a name is one segment.
  it.each([
    ['a traversal', '../escape.md'],
    ['a traversal in the middle', 'src/../../escape.md'],
    ['an absolute path', '/tmp/escape.md'],
    ['an empty name', ''],
    ['a dot', '.'],
    ['a double dot', '..'],
    ['a double slash', 'src//x.md'],
  ])('refuses %s', (_case, relative) => {
    const root = project()
    const result = createFile(root, relative)
    expect(result.ok).toBe(false)
    expect(existsSync(join(root, '..', 'escape.md'))).toBe(false)
  })

  // reason: creating a file that also creates three directories on the way is
  // a typo doing more than the user asked.
  it('refuses a folder that does not exist yet', () => {
    expect(createFile(project(), 'nope/deep/file.md')).toEqual({
      ok: false,
      reason: 'That folder is not in the project.',
    })
  })
})

describe('createFolder', () => {
  it('creates a directory', () => {
    const root = project()
    expect(createFolder(root, 'docs').ok).toBe(true)
    expect(statSync(join(root, 'docs')).isDirectory()).toBe(true)
  })

  it('creates one inside another', () => {
    const root = project()
    expect(createFolder(root, 'src/components').ok).toBe(true)
    expect(statSync(join(root, 'src', 'components')).isDirectory()).toBe(true)
  })

  it('refuses a name already taken', () => {
    expect(createFolder(project(), 'src').ok).toBe(false)
  })

  it('creates only itself, not the path to it', () => {
    const root = project()
    expect(createFolder(root, 'a/b/c').ok).toBe(false)
    expect(existsSync(join(root, 'a'))).toBe(false)
  })
})

describe('creationParent', () => {
  // reason: selecting a file means "beside this one", which is what every
  // editor does.
  it('puts a new entry beside a selected file', () => {
    expect(creationParent('src/index.ts', false)).toBe('src')
  })

  it('puts it inside a selected folder', () => {
    expect(creationParent('src', true)).toBe('src')
  })

  it('puts it at the root when nothing is selected', () => {
    expect(creationParent('', false)).toBe('')
  })

  it('puts it at the root beside a file that is already there', () => {
    expect(creationParent('readme.md', false)).toBe('')
  })
})
