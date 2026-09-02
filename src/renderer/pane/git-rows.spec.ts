import { describe, expect, it } from 'vitest'
import { colourOf, label, rowsFor } from './git-rows'

const EMPTY = { branch: 'main', ahead: 0, behind: 0, staged: [], changed: [], untracked: [] }

describe('rowsFor', () => {
  it('groups the three sections in the order they are read', () => {
    const groups = rowsFor({
      ...EMPTY,
      staged: [{ path: 'a.ts', status: 'M' }],
      changed: [{ path: 'b.ts', status: 'M' }],
      untracked: [{ path: 'c.ts', status: '?' }],
    })
    expect(groups.map((group) => group.section)).toEqual(['staged', 'changed', 'untracked'])
  })

  // reason: an empty heading is noise in a panel read at a glance.
  it('leaves out a section with nothing in it', () => {
    expect(rowsFor({ ...EMPTY, changed: [{ path: 'b.ts', status: 'M' }] }).map((g) => g.section)).toEqual(['changed'])
  })

  it('sorts by path, so a row does not move as the status changes', () => {
    const groups = rowsFor({
      ...EMPTY,
      changed: [{ path: 'z.ts', status: 'M' }, { path: 'a.ts', status: 'D' }],
    })
    expect(groups[0].entries.map((entry) => entry.path)).toEqual(['a.ts', 'z.ts'])
  })
})

describe('label', () => {
  it('shows the filename, with its directory after it', () => {
    expect(label({ path: 'src/main/a.ts', status: 'M' })).toBe('a.ts src/main')
  })

  it('shows a file at the root with no directory', () => {
    expect(label({ path: 'a.ts', status: 'M' })).toBe('a.ts')
  })

  // reason: a rename that only moved a file says nothing useful unless it
  // says where from.
  it('says where a rename came from', () => {
    expect(label({ path: 'b.ts', status: 'R', from: 'a.ts' })).toBe('b.ts ← a.ts')
  })
})

describe('colourOf', () => {
  it('gives each status its own colour, and an unknown one the default', () => {
    expect(new Set(['A', 'M', 'D', '?'].map(colourOf)).size).toBe(4)
    expect(colourOf('X')).toBe(colourOf('M'))
  })
})
