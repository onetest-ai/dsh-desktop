import { describe, expect, it, vi } from 'vitest'
import { commit, discard, stage, unstage } from './git-actions'
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

describe('commit', () => {
  // reason: the tick means "include this", and `git commit` commits the whole
  // index — so anything staged but unticked would ride along. Reconciling the
  // index to the selection is the only way the commit matches what was asked
  // for, and the spec states the consequence: an unticked file that was
  // staged is unstaged, and stays that way.
  it('stages what is ticked, unstages what is staged but is not, then commits', async () => {
    const run = vi.fn(async () => ok())
    expect(await commit('/r', 'a message', ['new.ts', 'both.ts'], [], ['both.ts', 'unwanted.ts'], run)).toEqual({
      ok: true,
    })
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['add', '--', 'new.ts', 'both.ts'],
      ['restore', '--staged', '--', 'unwanted.ts'],
      ['commit', '-m', 'a message'],
    ])
  })

  it('skips the reconciliation commands it has nothing for', async () => {
    const run = vi.fn(async () => ok())
    await commit('/r', 'm', ['a.ts'], [], ['a.ts'], run)
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['add', '--', 'a.ts'],
      ['commit', '-m', 'm'],
    ])
  })

  // reason: committing with nothing ticked would make an empty commit, and
  // committing with no message opens an editor that has no terminal to
  // appear in — the panel disables the button for both, and this is the
  // second door.
  it('refuses an empty message and an empty selection, without running git', async () => {
    const run = vi.fn(async () => ok())
    expect(await commit('/r', '   ', ['a.ts'], [], [], run)).toEqual({
      ok: false,
      reason: 'Write a commit message first.',
    })
    expect(await commit('/r', 'm', [], [], [], run)).toEqual({
      ok: false,
      reason: 'Tick at least one file to commit.',
    })
    expect(run).not.toHaveBeenCalled()
  })

  // reason: a failing hook is the common case, and its own output is the
  // only thing that says what to fix.
  it('reports a failure without committing anything after it', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail('hook declined the commit'))
    const out = await commit('/r', 'm', ['a.ts'], [], [], run)
    expect(out).toEqual({ ok: false, reason: 'hook declined the commit' })
  })

  // reason: stage can fail, e.g. due to permission issues. The failure must
  // be returned without proceeding to unstage or commit.
  it('stops when stage fails, returning the reason and having run git once', async () => {
    const run = vi.fn(async () => fail('permission denied'))
    const out = await commit('/r', 'm', ['a.ts'], [], ['b.ts'], run)
    expect(out).toEqual({ ok: false, reason: 'permission denied' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual(['add', '--', 'a.ts'])
  })

  // reason: unstage can fail, e.g. if a path is no longer valid. The failure
  // must be returned without proceeding to commit.
  it('stops when unstage fails, having run stage and unstage but not commit', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail('pathspec did not match'))
    const out = await commit('/r', 'm', ['a.ts'], [], ['b.ts'], run)
    expect(out).toEqual({ ok: false, reason: 'pathspec did not match' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['add', '--', 'a.ts'],
      ['restore', '--staged', '--', 'b.ts'],
    ])
  })

  // reason: a path appearing in both Staged Changes and Changes with a tick
  // only in Staged means keep what is indexed, not the newer edits. The path
  // must not be passed to `git add`, must not be unstaged, and commit must run.
  it('keeps staged-only ticked files, never re-adding them', async () => {
    const run = vi.fn(async () => ok())
    const out = await commit('/r', 'm', [], ['kept.ts'], ['kept.ts'], run)
    expect(out).toEqual({ ok: true })
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['commit', '-m', 'm'],
    ])
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
