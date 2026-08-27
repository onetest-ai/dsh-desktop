import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDirectory, resolveInRoot } from './file-tree'

/** A project directory with the given files and directories in it. */
function project(names: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-'))
  for (const name of names) {
    if (name.endsWith('/')) mkdirSync(join(root, name), { recursive: true })
    else {
      mkdirSync(join(root, name, '..'), { recursive: true })
      writeFileSync(join(root, name), '')
    }
  }
  return root
}

describe('resolveInRoot', () => {
  it('resolves a path inside the root', () => {
    const root = project(['src/', 'src/index.ts'])
    expect(resolveInRoot(root, 'src/index.ts')).toContain('index.ts')
  })

  it('resolves the root itself', () => {
    const root = project()
    expect(resolveInRoot(root, '')).toBeDefined()
  })

  // reason: this path arrives from the renderer and, through the view tools,
  // from the model. It is the check that keeps either from naming a file
  // outside the project it was given.
  it.each([
    ['a parent traversal', '../../etc/passwd'],
    ['a traversal that climbs back down', 'src/../../outside'],
    ['an absolute path, which would replace the root outright', '/etc/passwd'],
  ])('refuses %s', (_case, relative) => {
    expect(resolveInRoot(project(['src/']), relative)).toBeUndefined()
  })

  // reason: a symlink's literal path looks contained, so comparing before
  // resolving would let one out of the project.
  it('refuses a symlink whose target is outside the root', () => {
    const outside = project(['secret.txt'])
    const root = project()
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    expect(resolveInRoot(root, 'link.txt')).toBeUndefined()
  })

  it('allows a symlink whose target is inside the root', () => {
    const root = project(['real.txt'])
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'))
    expect(resolveInRoot(root, 'link.txt')).toBeDefined()
  })

  it('refuses a path that does not exist', () => {
    expect(resolveInRoot(project(), 'nope.txt')).toBeUndefined()
  })
})

describe('readDirectory', () => {
  it('lists directories before files, each alphabetically', () => {
    const root = project(['zebra.ts', 'alpha.ts', 'src/', 'lib/'])
    expect(readDirectory(root, '').map((entry) => entry.name)).toEqual(['lib', 'src', 'alpha.ts', 'zebra.ts'])
  })

  it('sorts without regard to case, the way a file browser does', () => {
    const root = project(['Beta.ts', 'alpha.ts'])
    expect(readDirectory(root, '').map((entry) => entry.name)).toEqual(['alpha.ts', 'Beta.ts'])
  })

  // reason: these are enormous or noise, and nobody browses them here.
  it.each(['.git', 'node_modules'])('hides %s', (name) => {
    const root = project([`${name}/`, 'src/'])
    expect(readDirectory(root, '').map((entry) => entry.name)).toEqual(['src'])
  })

  it('hides .DS_Store', () => {
    const root = project(['.DS_Store', 'src/'])
    expect(readDirectory(root, '').map((entry) => entry.name)).toEqual(['src'])
  })

  // reason: a project's own .dsh and .env are exactly what someone opens this
  // tree to find, so the ignore list stays short rather than hiding dotfiles.
  it('shows every other dotfile', () => {
    const root = project(['.dsh/', '.env'])
    expect(readDirectory(root, '').map((entry) => entry.name)).toEqual(['.dsh', '.env'])
  })

  it('marks directories as such', () => {
    const root = project(['src/', 'index.ts'])
    expect(readDirectory(root, '')).toEqual([
      { name: 'src', directory: true },
      { name: 'index.ts', directory: false },
    ])
  })

  it('lists a subdirectory, not a whole walk', () => {
    const root = project(['src/', 'src/deep/', 'src/index.ts'])
    expect(readDirectory(root, 'src').map((entry) => entry.name)).toEqual(['deep', 'index.ts'])
  })

  it('lists nothing for a path that escapes the root', () => {
    expect(readDirectory(project(['src/']), '../..')).toEqual([])
  })
})
