import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findEntity, readBoard } from './board-read'

let project = ''
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dsh-board-'))
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Write one entity file into the board.
 * @param folderPath - the folder within the board.
 * @param file - the file name, `workitem.yaml`, `bug.yaml` or `test.yaml`.
 * @param body - the YAML body.
 */
function put(folderPath: string, file: string, body: string): void {
  const dir = join(project, '.dsh', 'tasks', folderPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), body)
}

describe('readBoard', () => {
  it('reports a project with no board rather than failing', () => {
    const board = readBoard(project)
    expect(board.present).toBe(false)
    expect(board.campaigns).toEqual([])
    expect(board.findings).toEqual([])
  })

  it('reads a campaign, its mission, and its task', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nstatus: executing\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\nstatus: draft\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml', 'name: T1\nstatus: done\n')
    const board = readBoard(project)
    expect(board.present).toBe(true)
    expect(board.campaigns).toHaveLength(1)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].children[0].name).toBe('M1')
    expect(board.campaigns[0].children[0].children[0].status).toBe('done')
  })

  it('reads a bug under a campaign and a bug under a mission', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    put('campaigns/q3/bugs/b1', 'bug.yaml', 'name: B1\nseverity: blocker\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\n')
    put('campaigns/q3/missions/m1/bugs/b2', 'bug.yaml', 'name: B2\n')
    const board = readBoard(project)
    const levels = board.campaigns[0].children.map((child) => `${child.level}:${child.name}`)
    expect(levels).toContain('bug:B1')
    expect(levels).toContain('mission:M1')
    const mission = board.campaigns[0].children.find((child) => child.level === 'mission')
    expect(mission?.children.map((child) => child.name)).toEqual(['B2'])
  })

  // reason: children are folder-derived, so a folder with no entity file in it
  // is not an entity — and must not become an empty one with a slug for a name.
  it('skips a folder that holds no entity file', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'missions', 'empty'), { recursive: true })
    expect(readBoard(project).campaigns[0].children).toEqual([])
  })

  // reason: reading never writes and never repairs. A file that will not parse
  // is a finding naming it, and an entity that is simply absent.
  it('reports a file it cannot parse and leaves it out', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: [unclosed\n')
    const board = readBoard(project)
    expect(board.campaigns[0].children).toEqual([])
    expect(board.findings).toHaveLength(1)
    expect(board.findings[0].folderPath).toBe('campaigns/q3/missions/m1')
  })

  // reason: a board whose columns are whatever anyone typed is not a board.
  it('reports a status that is not one of the six', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nstatus: inprogress\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('inprogress'))).toBe(true)
  })

  // reason: a task with no checkable definition of done cannot be gated, and
  // gating is the point. Reported, never refused.
  it('reports a task with no acceptance criteria, and still reads it', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml', 'name: T1\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('acceptance criterion'))).toBe(true)
    expect(board.campaigns[0].children[0].children).toHaveLength(1)
  })

  // reason: progress is computed and shown; it is never written. This is the
  // rule the whole design is defined against.
  it('counts progress without touching any status', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nstatus: draft\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\nstatus: draft\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml', 'name: T1\nstatus: done\n')
    put('campaigns/q3/missions/m1/tasks/t2', 'workitem.yaml', 'name: T2\nstatus: draft\n')
    const board = readBoard(project)
    const mission = board.campaigns[0].children[0]
    expect(mission.progress).toEqual({ done: 1, total: 2 })
    // The mission's own status is what its file says, whatever its children do.
    expect(mission.status).toBe('draft')
    expect(board.campaigns[0].status).toBe('draft')
  })

  // reason: the case the mission-with-a-draft-child test above can't catch —
  // every child done, at both levels. A rollup that only fires on full
  // completion (children.every(...)) is a no-op on a partial mission, so the
  // rule needs a fixture where completion actually is full, for the mission
  // and for the campaign above it, or a rollup can hide behind "all tests pass."
  it('keeps a parent status as its file declares it, even when every child is done', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nstatus: draft\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\nstatus: draft\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml', 'name: T1\nstatus: done\n')
    put('campaigns/q3/missions/m1/tasks/t2', 'workitem.yaml', 'name: T2\nstatus: done\n')
    const board = readBoard(project)
    const campaign = board.campaigns[0]
    const mission = campaign.children[0]
    // Every task is done, and still neither parent's status moved.
    expect(mission.status).toBe('draft')
    expect(campaign.status).toBe('draft')
    // Progress reports the same completion that status must not adopt.
    expect(mission.progress).toEqual({ done: 2, total: 2 })
    expect(campaign.progress).toEqual({ done: 0, total: 1 })
  })

  // reason: readBoard only ever descends into `campaigns/`, so a `.trash` at
  // the board root is never a candidate regardless of the filter — this has
  // to plant one where readBoard actually looks, or deleting the filter would
  // leave the test passing for the wrong reason.
  it("never reads a .trash folder found while listing an entity's children", () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    put('campaigns/q3/missions/.trash', 'workitem.yaml', 'name: Gone\n')
    expect(readBoard(project).campaigns[0].children).toEqual([])
  })

  it('sorts by slug so two reads of one board agree', () => {
    put('campaigns/b', 'workitem.yaml', 'name: B\n')
    put('campaigns/a', 'workitem.yaml', 'name: A\n')
    expect(readBoard(project).campaigns.map((c) => c.slug)).toEqual(['a', 'b'])
  })
})

describe('findEntity', () => {
  it('finds an entity anywhere in the tree by its folder path', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml', 'name: T1\n')
    const board = readBoard(project)
    expect(findEntity(board, 'campaigns/q3/missions/m1/tasks/t1')?.name).toBe('T1')
    expect(findEntity(board, 'campaigns/nope')).toBeUndefined()
  })
})

describe('reading the three types', () => {
  it('reads a campaign, a mission and a task as workitems at their own levels', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nsubtype: campaign\nstatus: executing\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\nsubtype: mission\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml', 'name: T1\nsubtype: task\nstatus: done\n')
    const board = readBoard(project)
    expect(board.campaigns[0].level).toBe('campaign')
    expect(board.campaigns[0].children[0].level).toBe('mission')
    expect(board.campaigns[0].children[0].children[0].level).toBe('task')
  })

  // reason: the path is what the reader walks, so it decides. The key is what
  // the file claims, and a claim that disagrees with where it sits is worth
  // saying out loud rather than quietly overruling.
  it('trusts the path over a subtype that disagrees, and reports the disagreement', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nsubtype: mission\n')
    const board = readBoard(project)
    expect(board.campaigns[0].level).toBe('campaign')
    expect(board.findings.some((f) => f.says.includes('subtype'))).toBe(true)
  })

  it('reports nothing when the subtype is simply absent', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    expect(readBoard(project).findings).toEqual([])
  })
})

describe('reading tests', () => {
  it('reads a test at the root of the tests container', () => {
    put('tests/login', 'test.yaml', 'name: Login\nsteps: click\nexpected: works\n')
    const board = readBoard(project)
    expect(board.tests.tests.map((t) => t.name)).toEqual(['Login'])
    expect(board.tests.tests[0].folderPath).toBe('tests/login')
  })

  // reason: a suite is a directory and nothing else, so depth is free and a
  // directory holding no test.yaml is a suite rather than a broken test.
  it('reads nested suites to any depth', () => {
    put('tests/auth/oauth/callback', 'test.yaml', 'name: Callback\n')
    const board = readBoard(project)
    expect(board.tests.suites.map((s) => s.slug)).toEqual(['auth'])
    expect(board.tests.suites[0].suites[0].slug).toBe('oauth')
    expect(board.tests.suites[0].suites[0].tests[0].name).toBe('Callback')
  })

  it('gives a test no status, because it is not work in flight', () => {
    put('tests/login', 'test.yaml', 'name: Login\n')
    expect(readBoard(project).tests.tests[0].status).toBe('')
  })

  it('reports a project with tests but no campaigns without failing', () => {
    put('tests/login', 'test.yaml', 'name: Login\n')
    const board = readBoard(project)
    expect(board.present).toBe(true)
    expect(board.campaigns).toEqual([])
  })

  it('answers with an empty tests root when there are none', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    expect(readBoard(project).tests).toEqual({ path: 'tests', slug: 'tests', suites: [], tests: [] })
  })
})

describe('findings about links', () => {
  beforeEach(() => {
    put('tests/login', 'test.yaml', 'name: Login\n')
  })

  it('says nothing about a link that resolves', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: pass\n')
    expect(readBoard(project).findings).toEqual([])
  })

  // reason: a validated_by entry that quietly vanished would turn "this is
  // proven" into "this was proven once" with nothing to say so.
  it('reports a link naming a test that is not there', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/gone\n    result: pass\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('tests/gone'))).toBe(true)
  })

  it('reports a result that is not one of the three', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: green\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('green'))).toBe(true)
  })

  // reason: a failure nobody wrote down should not read as fine.
  it('reports a failing link with no bug against it', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: fail\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('no bug'))).toBe(true)
  })

  it('says nothing about a failing link that names one', () => {
    put('campaigns/q3/bugs/b1', 'bug.yaml', 'name: B1\n')
    put(
      'campaigns/q3',
      'workitem.yaml',
      'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: fail\n    bug: campaigns/q3/bugs/b1\n',
    )
    expect(readBoard(project).findings).toEqual([])
  })
})
