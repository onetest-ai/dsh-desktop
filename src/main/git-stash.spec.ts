import { describe, expect, it, vi } from 'vitest'
import { applyStash, dropStash, parseStashes, pushStash } from './git-stash'
import type { GitResult } from './git-run'

const bytes = (...lines: string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8')
const ok = (): GitResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })
const fail = (why: string): GitResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: why })

describe('parseStashes', () => {
  it('reads the ref, the branch it was made on, and the message', () => {
    expect(parseStashes(bytes('stash@{0}\tOn main: wip thing'))).toEqual([
      { ref: 'stash@{0}', branch: 'main', message: 'wip thing' },
    ])
  })

  // reason: a stash pushed without a message gets git's own subject, which
  // names the commit it was taken from — useless as a label but all there
  // is, so it is shown rather than blanked.
  it('reads an unnamed stash, keeping what git called it', () => {
    const [stash] = parseStashes(bytes('stash@{1}\tWIP on feature: 1a2b3c4 earlier subject'))
    expect(stash.branch).toBe('feature')
    expect(stash.message).toBe('1a2b3c4 earlier subject')
  })

  // reason: a colon in the message must not be read as the branch separator,
  // or every stash named "fix: something" reports the wrong branch.
  it('splits on the first colon only', () => {
    const [stash] = parseStashes(bytes('stash@{0}\tOn main: fix: the thing'))
    expect(stash.branch).toBe('main')
    expect(stash.message).toBe('fix: the thing')
  })

  it('reads nothing from nothing', () => {
    expect(parseStashes(Buffer.alloc(0))).toEqual([])
  })
})

describe('pushStash', () => {
  it('pushes the working tree with the message it was given', async () => {
    const run = vi.fn(async () => ok())
    expect(await pushStash('/r', 'wip thing', run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['stash', 'push', '-m', 'wip thing'])
  })

  it('pushes without a message when none was written', async () => {
    const run = vi.fn(async () => ok())
    await pushStash('/r', '   ', run)
    expect(run).toHaveBeenCalledWith('/r', ['stash', 'push'])
  })

  // reason: `git stash push` on a clean tree exits 0 and does nothing, so a
  // panel that just reports success leaves the user believing a stash
  // exists.
  it('says so when there was nothing to stash', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: Buffer.from('No local changes to save\n'), stderr: '' }))
    expect(await pushStash('/r', '', run)).toEqual({ ok: false, reason: 'There is nothing to stash.' })
  })

  // reason: a git that times out or fails at the exec level can exit
  // non-zero with nothing on stderr, and the panel then shows an empty
  // message — which is worse than a wrong one, because the user cannot tell
  // whether anything happened. The fallback guards against this.
  it('reports a fallback when git failed with empty stderr', async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: '' }))
    expect(await pushStash('/r', 'wip', run)).toEqual({ ok: false, reason: 'git failed without saying why.' })
  })
})

describe('applyStash', () => {
  it('applies without removing, and pops with removing', async () => {
    const run = vi.fn(async () => ok())
    await applyStash('/r', 'stash@{0}', false, run)
    await applyStash('/r', 'stash@{0}', true, run)
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['stash', 'apply', 'stash@{0}'],
      ['stash', 'pop', 'stash@{0}'],
    ])
  })

  // reason: a pop that conflicts leaves the stash in place and the tree
  // half-merged; reporting success would hide both.
  it('reports a conflicting pop as a failure', async () => {
    const run = vi.fn(async () => fail('CONFLICT (content): Merge conflict in a.ts'))
    expect(await applyStash('/r', 'stash@{0}', true, run)).toEqual({
      ok: false,
      reason: 'CONFLICT (content): Merge conflict in a.ts',
    })
  })
})

describe('dropStash', () => {
  it('drops exactly the ref it was given', async () => {
    const run = vi.fn(async () => ok())
    await dropStash('/r', 'stash@{2}', run)
    expect(run).toHaveBeenCalledWith('/r', ['stash', 'drop', 'stash@{2}'])
  })
})
