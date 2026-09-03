import { describe, expect, it } from 'vitest'
import { Selection } from './git-select'
import type { EntryView } from './git-rows'

const status = (over: Partial<Record<'staged' | 'changed' | 'untracked', EntryView[]>> = {}) => ({
  branch: 'main',
  ahead: 0,
  behind: 0,
  staged: [],
  changed: [],
  untracked: [],
  ...over,
})

describe('Selection', () => {
  // reason: committing a file nobody noticed is how build output, scratch
  // files and credentials reach a repository, and an untracked file is by
  // definition one git has never seen before.
  it('ticks tracked changes by default and leaves untracked ones alone', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] })
    selection.reconcile('/r', state)
    expect(selection.ticked('/r', 'changed', 'a.ts')).toBe(true)
    expect(selection.ticked('/r', 'untracked', 'new.ts')).toBe(false)
  })

  it('remembers a tick and an untick across a refresh', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] })
    selection.reconcile('/r', state)
    selection.toggle('/r', 'changed', 'a.ts')
    selection.toggle('/r', 'untracked', 'new.ts')
    selection.reconcile('/r', state)
    expect(selection.ticked('/r', 'changed', 'a.ts')).toBe(false)
    expect(selection.ticked('/r', 'untracked', 'new.ts')).toBe(true)
  })

  // reason: a file that has gone must not keep a tick that would be applied
  // to a different file of the same name later.
  it('forgets a path that is no longer changed', () => {
    const selection = new Selection()
    selection.reconcile('/r', status({ changed: [{ path: 'a.ts', status: 'M' }] }))
    selection.toggle('/r', 'changed', 'a.ts')
    selection.reconcile('/r', status({}))
    selection.reconcile('/r', status({ changed: [{ path: 'a.ts', status: 'M' }] }))
    expect(selection.ticked('/r', 'changed', 'a.ts')).toBe(true)
  })

  // reason: two repositories in one project may hold a file of the same
  // name, and ticking one must not tick the other.
  it('keeps repositories apart', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }] })
    selection.reconcile('/one', state)
    selection.reconcile('/two', state)
    selection.toggle('/one', 'changed', 'a.ts')
    expect(selection.ticked('/one', 'changed', 'a.ts')).toBe(false)
    expect(selection.ticked('/two', 'changed', 'a.ts')).toBe(true)
  })

  it('sets or clears a whole section at once', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] })
    selection.reconcile('/r', state)
    selection.setSection('/r', 'changed', ['a.ts', 'b.ts'], false)
    expect(selection.selected('/r', state)).toEqual({ add: [], keep: [] })
    selection.setSection('/r', 'changed', ['a.ts', 'b.ts'], true)
    expect(selection.selected('/r', state)).toEqual({ add: ['a.ts', 'b.ts'], keep: [] })
  })

  // reason: a file staged and then edited again appears in two sections, and
  // committing it twice would be a nonsense argument list — and the two rows
  // mean different content, so the flat "commit these paths" idea is wrong:
  // the split into add/keep is what keeps them from colliding.
  it('names a path once even when it is in two sections, ticked in both', () => {
    const selection = new Selection()
    const state = status({
      staged: [{ path: 'both.ts', status: 'M' }],
      changed: [{ path: 'both.ts', status: 'M' }],
    })
    selection.reconcile('/r', state)
    expect(selection.selected('/r', state)).toEqual({ add: ['both.ts'], keep: [] })
  })

  // reason: the staged row is the version already recorded; re-adding it
  // would stage the newer working-tree content and silently destroy the
  // version the tick existed to preserve.
  it('a path ticked in Staged only is kept, not added', () => {
    const selection = new Selection()
    const state = status({
      staged: [{ path: 'both.ts', status: 'M' }],
      changed: [{ path: 'both.ts', status: 'M' }],
    })
    selection.reconcile('/r', state)
    selection.toggle('/r', 'changed', 'both.ts') // untick the changed row, leave staged ticked
    expect(selection.selected('/r', state)).toEqual({ add: [], keep: ['both.ts'] })
  })

  // reason: the mirror case — only the newer content is wanted, so the path
  // must be added and must not also be treated as already-staged content to
  // preserve untouched.
  it('a path ticked in Changes only is added, not kept', () => {
    const selection = new Selection()
    const state = status({
      staged: [{ path: 'both.ts', status: 'M' }],
      changed: [{ path: 'both.ts', status: 'M' }],
    })
    selection.reconcile('/r', state)
    selection.toggle('/r', 'staged', 'both.ts') // untick the staged row, leave changed ticked
    expect(selection.selected('/r', state)).toEqual({ add: ['both.ts'], keep: [] })
  })

  // reason: ticked in both, add wins — a path in add must never also appear
  // in keep, or the same file would be both re-added and left alone.
  it('a path ticked in both Staged and Changes is added, not kept', () => {
    const selection = new Selection()
    const state = status({
      staged: [{ path: 'both.ts', status: 'M' }],
      changed: [{ path: 'both.ts', status: 'M' }],
    })
    selection.reconcile('/r', state)
    const { add, keep } = selection.selected('/r', state)
    expect(add).toEqual(['both.ts'])
    expect(keep).toEqual([])
  })

  // reason: the two rows are independent checkboxes over independent content
  // — ticking one must never move the other.
  it('ticking the Staged row of a path does not tick its Changes row, and vice versa', () => {
    const selection = new Selection()
    const state = status({
      staged: [{ path: 'both.ts', status: 'M' }],
      changed: [{ path: 'both.ts', status: 'M' }],
    })
    selection.reconcile('/r', state)
    // both start ticked (both sections are tracked); clear both, then flip one at a time
    selection.setSection('/r', 'staged', ['both.ts'], false)
    selection.setSection('/r', 'changed', ['both.ts'], false)
    expect(selection.ticked('/r', 'staged', 'both.ts')).toBe(false)
    expect(selection.ticked('/r', 'changed', 'both.ts')).toBe(false)

    selection.toggle('/r', 'staged', 'both.ts')
    expect(selection.ticked('/r', 'staged', 'both.ts')).toBe(true)
    expect(selection.ticked('/r', 'changed', 'both.ts')).toBe(false)

    selection.toggle('/r', 'changed', 'both.ts')
    expect(selection.ticked('/r', 'staged', 'both.ts')).toBe(true)
    expect(selection.ticked('/r', 'changed', 'both.ts')).toBe(true)
  })

  // reason: git holds a rename as the deletion of the old name beside the
  // addition of the new, and `commit` unstages every staged path that is in
  // neither list. A `keep` naming only the new path leaves that deletion to
  // be unstaged, and the commit records half a rename.
  it('keeps both names of a ticked staged rename', () => {
    const selection = new Selection()
    const state = status({ staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }] })
    selection.reconcile('/r', state)
    expect(selection.selected('/r', state).keep).toEqual(['new.ts', 'old.ts'])
  })

  // reason: the old name is gone from disk. `git add old.ts` fails with a
  // pathspec error, and `commit` stops at the first failure — so a rename
  // that reached `add` would abort the commit rather than record it.
  it('never puts the old name of a rename in add', () => {
    const selection = new Selection()
    const state = status({
      staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }],
      changed: [{ path: 'new.ts', status: 'M', from: 'old.ts' }],
    })
    selection.reconcile('/r', state)
    const { add, keep } = selection.selected('/r', state)
    expect(add).toEqual(['new.ts'])
    // In `add`, so not in `keep` either — a path is never in both.
    expect(keep).toEqual([])
  })
})
