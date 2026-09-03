import { describe, expect, it } from 'vitest'
import { colourOf, parts, rowsFor } from './git-rows'

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

describe('parts', () => {
  // reason: the name is what is being looked for and the directory only
  // disambiguates it, so they are two pieces the row can weight differently
  // — joined into one string neither can be dimmed, and truncation would
  // eat the filename before the path it is there to qualify.
  it('separates the filename from its directory', () => {
    expect(parts({ path: 'src/main/a.ts', status: 'M' })).toEqual({ name: 'a.ts', dir: 'src/main' })
  })

  it('gives a file at the root no directory at all', () => {
    expect(parts({ path: 'a.ts', status: 'M' })).toEqual({ name: 'a.ts', dir: '' })
  })

  // reason: a rename that only moved a file says nothing useful unless it
  // says where from, and where from belongs with the path rather than the
  // name — it is the same kind of fact.
  it('says where a rename came from, in place of the directory', () => {
    expect(parts({ path: 'b.ts', status: 'R', from: 'a.ts' })).toEqual({ name: 'b.ts', dir: '← a.ts' })
  })

  it('keeps a name containing spaces whole', () => {
    expect(parts({ path: 'a b/c d.ts', status: 'M' })).toEqual({ name: 'c d.ts', dir: 'a b' })
  })
})

describe('rowsFor counts', () => {
  // reason: the size of the job is worth knowing without counting rows.
  it('reports how many entries each section holds', () => {
    const groups = rowsFor({
      ...EMPTY,
      changed: [
        { path: 'a.ts', status: 'M' },
        { path: 'b.ts', status: 'M' },
      ],
    })
    expect(groups[0].entries.length).toBe(2)
  })
})

describe('colourOf', () => {
  it('gives each status its own colour, and an unknown one the default', () => {
    expect(new Set(['A', 'M', 'D', '?'].map(colourOf)).size).toBe(4)
    expect(colourOf('X')).toBe(colourOf('M'))
  })
})
