import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { diffSides, gitDiffFor, readProject } from './git-model'
import type { GitResult } from './git-run'

/**
 * A real repository directory and a real sibling that shares its name as a
 * prefix, both on disk — `pathInRepo` resolves through `realpath`, so a
 * fixture that does not really exist would not exercise it.
 */
function demoTree(): { repo: string; sibling: string } {
  const root = mkdtempSync(join(tmpdir(), 'git-model-'))
  const repo = join(root, 'demo')
  const sibling = join(root, 'demo-other')
  mkdirSync(join(repo, 'sub'), { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(repo, 'sub', 'file.ts'), 'inside\n')
  writeFileSync(join(sibling, 'secret.txt'), 'not this repo\'s to read\n')
  return { repo, sibling }
}

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

// reason: `git:open-diff` is reachable from a renderer and names a repository
// and a path — neither is evidence of anything, so the repository is checked
// against what was actually discovered in the open project rather than taken
// on the row's word, the same rule the web view's own local-file loading
// follows.
describe('gitDiffFor', () => {
  it('refuses a diff for a repository outside the open project', async () => {
    const { repo } = demoTree()
    expect(await gitDiffFor('/etc', 'passwd', 'changed', () => [repo])).toBeUndefined()
  })

  it('allows a normal path nested inside the repository', async () => {
    const { repo } = demoTree()
    expect(await gitDiffFor(repo, 'sub/file.ts', 'changed', () => [repo])).toBeDefined()
  })

  // reason: `join` collapses `..` syntactically, and git itself reports paths
  // that came from the working tree rather than from the user — but the
  // channel this feeds is reachable from a renderer, which is reason enough
  // to check rather than trust it. This is the case the previous pair of
  // tests did not cover: they varied the repository with a fixed, well-formed
  // path, never a path that escapes a repository the caller is genuinely
  // allowed to read from.
  it('refuses a `..` path that climbs out of a valid repository', async () => {
    const { repo } = demoTree()
    expect(await gitDiffFor(repo, '../../../../../../etc/passwd', 'changed', () => [repo])).toBeUndefined()
  })

  it('refuses an absolute path', async () => {
    const { repo } = demoTree()
    expect(await gitDiffFor(repo, '/etc/passwd', 'changed', () => [repo])).toBeUndefined()
  })

  // reason: a prefix check without the separator would let `demo-other` pass
  // as being inside `demo` — the classic hole a bare `startsWith` opens.
  it('refuses a path resolving into a sibling that shares a name prefix', async () => {
    const { repo } = demoTree()
    expect(await gitDiffFor(repo, '../demo-other/secret.txt', 'changed', () => [repo])).toBeUndefined()
  })

  // reason: a row for a file deleted in the working tree names a path with
  // nothing on disk, and `diffSides` deliberately still answers that rather
  // than refusing — the containment check has to agree, or every deleted-file
  // row in `changed` would break.
  it('still produces a diff for a path that does not exist on disk', async () => {
    const { repo } = demoTree()
    expect(await gitDiffFor(repo, 'gone.ts', 'changed', () => [repo])).toBeDefined()
  })
})
