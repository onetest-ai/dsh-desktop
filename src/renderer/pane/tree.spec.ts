import { describe, expect, it, vi } from 'vitest'
import { Tree, type TreeDeps, type TreeEntry } from './tree'

const PROJECT = { path: '/p/demo', title: 'demo' }

/** Deps over a fixed directory layout. */
function deps(layout: Record<string, TreeEntry[]> = {}): TreeDeps & { listDirectory: ReturnType<typeof vi.fn> } {
  return {
    listDirectory: vi.fn(async (_root: string, relative: string) => layout[relative] ?? []),
    openFile: vi.fn(),
    select: vi.fn(),
  }
}

const LAYOUT = {
  '': [
    { name: 'src', directory: true },
    { name: 'readme.md', directory: false },
  ],
  src: [{ name: 'index.ts', directory: false }],
}

describe('Tree', () => {
  it('loads the root listing when a project is shown', async () => {
    const tree = new Tree(deps(LAYOUT))
    await tree.show(PROJECT)
    expect(tree.entries('')?.map((entry) => entry.name)).toEqual(['src', 'readme.md'])
  })

  it('loads a directory the first time it opens', async () => {
    const d = deps(LAYOUT)
    const tree = new Tree(d)
    await tree.show(PROJECT)
    await tree.toggle('src')
    expect(tree.open.has('src')).toBe(true)
    expect(tree.entries('src')?.map((entry) => entry.name)).toEqual(['index.ts'])
  })

  // reason: a directory the user closes and reopens is the same directory. A
  // fresh read per open would make the tree flicker on every click.
  it('does not read a directory again when it is reopened', async () => {
    const d = deps(LAYOUT)
    const tree = new Tree(d)
    await tree.show(PROJECT)
    await tree.toggle('src')
    await tree.toggle('src')
    await tree.toggle('src')
    expect(d.listDirectory.mock.calls.filter(([, relative]) => relative === 'src')).toHaveLength(1)
  })

  it('closes a directory that is open', async () => {
    const tree = new Tree(deps(LAYOUT))
    await tree.show(PROJECT)
    await tree.toggle('src')
    await tree.toggle('src')
    expect(tree.open.has('src')).toBe(false)
  })

  // reason: switching projects must not leave the previous one's directories
  // marked open — their paths could name real directories in the new one.
  it('forgets what was open when another project is shown', async () => {
    const tree = new Tree(deps(LAYOUT))
    await tree.show(PROJECT)
    await tree.toggle('src')
    await tree.show({ path: '/p/other', title: 'other' })
    expect(tree.open.size).toBe(0)
  })

  it('opens a file in the Editor tab', async () => {
    const d = deps(LAYOUT)
    const tree = new Tree(d)
    await tree.show(PROJECT)
    tree.openFile('readme.md')
    expect(d.openFile).toHaveBeenCalledWith('/p/demo', 'readme.md')
    expect(d.select).toHaveBeenCalledWith('editor')
  })

  it('opens nothing before a project is shown', () => {
    const d = deps()
    new Tree(d).openFile('readme.md')
    expect(d.openFile).not.toHaveBeenCalled()
  })
})
