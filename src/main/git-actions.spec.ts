import { describe, expect, it, vi } from 'vitest'
import { discard, stage, unstage } from './git-actions'
import type { GitResult } from './git-run'

const ok = (): GitResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })
const fail = (why: string): GitResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: `${why}\nstack line\n` })

describe('stage', () => {
  it('adds exactly the paths it was given, after a terminator', async () => {
    const run = vi.fn(async () => ok())
    expect(await stage('/r', ['a.ts', 'b.ts'], run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['add', '--', 'a.ts', 'b.ts'])
  })

  // reason: a path beginning with a dash is a filename, and without `--`
  // git reads it as an option — on `add` that is merely an error, but the
  // habit has to be uniform or the one place it matters gets missed.
  it('never lets a path be read as an option', async () => {
    const run = vi.fn(async () => ok())
    await stage('/r', ['-rf'], run)
    expect(run.mock.calls[0][1]).toEqual(['add', '--', '-rf'])
  })

  it('does nothing at all when given no paths', async () => {
    const run = vi.fn(async () => ok())
    expect(await stage('/r', [], run)).toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
  })

  // reason: the panel shows the first line; git's own second line is a hint
  // for a terminal, and a stack is never shown at all.
  it('reports only the first line of a failure', async () => {
    const run = vi.fn(async () => fail('fatal: pathspec did not match'))
    expect(await stage('/r', ['a.ts'], run)).toEqual({
      ok: false,
      reason: 'fatal: pathspec did not match',
    })
  })
})

describe('unstage', () => {
  it('restores the named paths in the index only', async () => {
    const run = vi.fn(async () => ok())
    await unstage('/r', ['a.ts'], run)
    expect(run).toHaveBeenCalledWith('/r', ['restore', '--staged', '--', 'a.ts'])
  })
})

describe('discard', () => {
  // reason: a tracked file is restored from the index; an untracked one has
  // nothing to restore to and must be deleted. Passing an untracked path to
  // `restore` fails with a pathspec error rather than doing nothing, which
  // — combined with stop-at-first-failure — means a misclassified path
  // aborts the discard before the untracked half runs.
  it('restores tracked paths and removes untracked ones, separately', async () => {
    const run = vi.fn(async () => ok())
    expect(await discard('/r', ['tracked.ts'], ['new.ts'], run)).toEqual({ ok: true })
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['restore', '--worktree', '--', 'tracked.ts'],
      ['clean', '-f', '-d', '--', 'new.ts'],
    ])
  })

  it('skips the command it has no paths for', async () => {
    const run = vi.fn(async () => ok())
    await discard('/r', [], ['new.ts'], run)
    expect(run.mock.calls.map((call) => call[1])).toEqual([['clean', '-f', '-d', '--', 'new.ts']])
  })

  it('removes a directory-shaped untracked path', async () => {
    const run = vi.fn(async () => ok())
    expect(await discard('/r', [], ['newdir/'], run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['clean', '-f', '-d', '--', 'newdir/'])
  })

  it('stops at the first failure rather than carrying on', async () => {
    const run = vi.fn(async () => fail('error: unable to unlink'))
    const out = await discard('/r', ['a.ts'], ['b.ts'], run)
    expect(out).toEqual({ ok: false, reason: 'error: unable to unlink' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
