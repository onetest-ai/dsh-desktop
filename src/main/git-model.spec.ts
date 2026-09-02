import { describe, expect, it, vi } from 'vitest'
import { diffSides, readProject } from './git-model'
import type { GitResult } from './git-run'

const ok = (out: string): GitResult => ({ code: 0, stdout: Buffer.from(out, 'utf8'), stderr: '' })
const fail = (why: string): GitResult => ({ code: 128, stdout: Buffer.alloc(0), stderr: why })

describe('diffSides', () => {
  // reason: which two things are compared depends on the section the row was
  // in, and getting it wrong shows a diff that is quietly about something
  // else — the most expensive kind of wrong.
  it('compares the index with the working tree for an unstaged change', async () => {
    const run = vi.fn(async () => ok('indexed\n'))
    const sides = await diffSides('/r', 'a.ts', 'changed', run)
    expect(run).toHaveBeenCalledWith('/r', ['show', ':a.ts'])
    expect(sides).toMatchObject({ ok: true, original: 'indexed\n' })
  })

  it('compares HEAD with the index for a staged change', async () => {
    const run = vi.fn(async () => ok('committed\n'))
    await diffSides('/r', 'a.ts', 'staged', run)
    expect(run).toHaveBeenCalledWith('/r', ['show', 'HEAD:a.ts'])
  })

  // reason: an untracked file has no previous version at all, and asking git
  // for one fails rather than returning nothing.
  it('compares an untracked file against nothing, without asking git', async () => {
    const run = vi.fn(async () => ok('unused'))
    const sides = await diffSides('/r', 'new.ts', 'untracked', run)
    expect(run).not.toHaveBeenCalled()
    expect(sides).toMatchObject({ ok: true, original: '' })
  })

  // reason: a file added and staged has no version in HEAD, which git reports
  // as an error — but "it is new" is the answer, not a failure.
  it('treats a missing previous version as empty rather than an error', async () => {
    const run = vi.fn(async () => fail("fatal: path 'a.ts' does not exist in 'HEAD'"))
    expect(await diffSides('/r', 'a.ts', 'staged', run)).toMatchObject({ ok: true, original: '' })
  })
})

describe('readProject', () => {
  it('says so when the project holds no repository', async () => {
    expect(await readProject('/nowhere/at/all', vi.fn(async () => ok('')))).toEqual({ ok: true, repos: [] })
  })

  // reason: the panel reports which repository failed and why; a git that
  // will not run is not a reason to show nothing at all.
  it('reports a repository git refused to read', async () => {
    const run = vi.fn(async () => fail('fatal: not a git repository'))
    const out = await readProject(process.cwd(), run)
    expect(out.ok).toBe(false)
  })
})
