import { describe, expect, it } from 'vitest'
import { parseStatus } from './git-status'

/** Records as git writes them: NUL-terminated, no trailing newline. */
const bytes = (...records: string[]): Buffer => Buffer.from(records.map((r) => `${r}\0`).join(''), 'utf8')

const HASH = '78981922613b2afb6025042ff6bd878ac1994e85'

describe('parseStatus', () => {
  it('reads the branch and how far it has diverged', () => {
    const status = parseStatus(bytes('# branch.head main', '# branch.ab +2 -3'))
    expect(status.branch).toBe('main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)
  })

  // reason: a detached HEAD reports this literally, and it is a state to show
  // rather than a name to print as though it were a branch.
  it('reports a detached HEAD as it is, with no divergence', () => {
    const status = parseStatus(bytes('# branch.head (detached)'))
    expect(status.branch).toBe('(detached)')
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
  })

  it('puts a staged change in staged and an unstaged one in changed', () => {
    const status = parseStatus(
      bytes(
        `1 M. N... 100644 100644 100644 ${HASH} ${HASH} staged.ts`,
        `1 .M N... 100644 100644 100644 ${HASH} ${HASH} changed.ts`,
      ),
    )
    expect(status.staged).toEqual([{ path: 'staged.ts', status: 'M' }])
    expect(status.changed).toEqual([{ path: 'changed.ts', status: 'M' }])
  })

  // reason: a file staged and then edited again is in both, and they mean
  // different content — the recorded version and the edits made since.
  it('lists a file that is both staged and edited in both sections', () => {
    const status = parseStatus(bytes(`1 MM N... 100644 100644 100644 ${HASH} ${HASH} both.ts`))
    expect(status.staged).toEqual([{ path: 'both.ts', status: 'M' }])
    expect(status.changed).toEqual([{ path: 'both.ts', status: 'M' }])
  })

  // reason: a rename record carries its original path as an EXTRA
  // NUL-delimited field. A parser that splits on NUL and treats every field
  // as a record reads that path as a record of its own and produces garbage.
  it('reads a rename without mistaking its old path for another record', () => {
    const status = parseStatus(
      bytes(`2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 new.ts`, 'old.ts', '? untracked.ts'),
    )
    expect(status.staged).toEqual([{ path: 'new.ts', status: 'R', from: 'old.ts' }])
    expect(status.untracked).toEqual([{ path: 'untracked.ts', status: '?' }])
  })

  it('collects untracked files, and ignores ignored ones', () => {
    const status = parseStatus(bytes('? new.ts', '! ignored.ts'))
    expect(status.untracked).toEqual([{ path: 'new.ts', status: '?' }])
  })

  // reason: an unmerged path is neither staged nor merely changed, and
  // dropping it would show a conflicted repo as clean.
  it('reports an unmerged path as a conflict in changed', () => {
    const status = parseStatus(
      bytes(`u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} conflict.ts`),
    )
    expect(status.changed).toEqual([{ path: 'conflict.ts', status: 'U' }])
  })

  it('reads a clean repository as clean', () => {
    const status = parseStatus(bytes('# branch.head main'))
    expect(status.staged).toEqual([])
    expect(status.changed).toEqual([])
    expect(status.untracked).toEqual([])
  })

  // reason: a path may contain a space, and every field before it is fixed —
  // so the path is what remains, not the last word.
  it('keeps a path that contains spaces whole', () => {
    const status = parseStatus(bytes(`1 .M N... 100644 100644 100644 ${HASH} ${HASH} a file.ts`))
    expect(status.changed).toEqual([{ path: 'a file.ts', status: 'M' }])
  })
})
