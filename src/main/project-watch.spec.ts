import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedDirectory, watchProject, type ProjectWatch } from './project-watch.ts'

describe('changedDirectory', () => {
  it('reports the root for a file at the top level', () => {
    expect(changedDirectory('notes.md')).toBe('')
  })

  it('reports the directory a nested file sits in', () => {
    expect(changedDirectory(join('src', 'main', 'index.ts'))).toBe('src/main')
  })

  it('ignores anything inside a directory the tree never lists', () => {
    expect(changedDirectory(join('node_modules', 'left-pad', 'index.js'))).toBeUndefined()
    expect(changedDirectory(join('.git', 'HEAD'))).toBeUndefined()
    expect(changedDirectory(join('src', '.git', 'x'))).toBeUndefined()
  })

  it('ignores an entry that is itself never listed', () => {
    expect(changedDirectory(join('src', '.DS_Store'))).toBeUndefined()
  })
})

describe('watchProject', () => {
  const watches: ProjectWatch[] = []
  const roots: string[] = []

  afterEach(() => {
    for (const watch of watches.splice(0)) watch.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * A temporary project directory, removed after the test.
   * @returns its path.
   */
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-watch-'))
    roots.push(root)
    return root
  }

  /**
   * Collect the directories a watch reports.
   *
   * A watcher may name a changed directory's ancestors as well as the
   * directory itself, so tests assert on what arrived rather than on which
   * report came first.
   * @param root - the project to watch.
   * @returns the reported directories, growing as they arrive.
   */
  async function watching(root: string): Promise<string[]> {
    const seen: string[] = []
    const watch = watchProject(root, (relative) => seen.push(relative))
    if (watch !== undefined) watches.push(watch)
    // The platform's watcher takes a moment to arm, and a change made inside
    // that window is genuinely missed — which would make these tests fail for
    // a reason that has nothing to do with what they check.
    await new Promise((resolve) => setTimeout(resolve, 250))
    return seen
  }

  /**
   * Wait for a directory to be reported.
   * @param seen - the directories reported so far.
   * @param relative - the one to wait for.
   * @returns resolution once it arrives, rejection once it clearly will not.
   */
  async function report(seen: string[], relative: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (seen.includes(relative)) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`never reported ${JSON.stringify(relative)}; saw ${JSON.stringify(seen)}`)
  }

  it('reports the root when a file is added to it', async () => {
    const root = project()
    const seen = await watching(root)
    writeFileSync(join(root, 'added.txt'), 'hi')
    await report(seen, '')
  })

  it('reports the directory a nested file was added to', async () => {
    const root = project()
    mkdirSync(join(root, 'deep', 'inner'), { recursive: true })
    const seen = await watching(root)
    writeFileSync(join(root, 'deep', 'inner', 'added.txt'), 'hi')
    await report(seen, 'deep/inner')
  })

  it('says nothing about a directory the tree never lists', async () => {
    const root = project()
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    const seen = await watching(root)
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'hi')
    // Then something the tree does show, so this waits on a real report
    // rather than on a timeout that would pass whether or not filtering works.
    writeFileSync(join(root, 'shown.txt'), 'hi')
    await report(seen, '')
    expect(seen.filter((each) => each.startsWith('node_modules'))).toEqual([])
  })

  it('says nothing after it is closed', async () => {
    const root = project()
    const seen = await watching(root)
    writeFileSync(join(root, 'before.txt'), 'hi')
    await report(seen, '')
    for (const watch of watches.splice(0)) watch.close()
    seen.length = 0
    writeFileSync(join(root, 'after.txt'), 'hi')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(seen).toEqual([])
  })
})
