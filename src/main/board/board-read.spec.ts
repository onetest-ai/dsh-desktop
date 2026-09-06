import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findEntity, findTest, readBoard } from './board-read'

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
 * @param file - the file name, `workitem.md`, `bug.md`, `test.md`, or their legacy `.yaml` forms.
 * @param body - the file's whole text.
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
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nstatus: executing\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: M1\nstatus: idea\n---\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.md', '---\nname: T1\nstatus: done\n---\n')
    const board = readBoard(project)
    expect(board.present).toBe(true)
    expect(board.campaigns).toHaveLength(1)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].children[0].name).toBe('M1')
    expect(board.campaigns[0].children[0].children[0].status).toBe('done')
  })

  it('reads a bug under a campaign and a bug under a mission', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/bugs/b1', 'bug.md', '---\nname: B1\nseverity: blocker\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: M1\n---\n')
    put('campaigns/q3/missions/m1/bugs/b2', 'bug.md', '---\nname: B2\n---\n')
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
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'missions', 'empty'), { recursive: true })
    expect(readBoard(project).campaigns[0].children).toEqual([])
  })

  // reason: reading never writes and never repairs. A file that will not parse
  // is a finding naming it, and an entity that is simply absent.
  it('reports a file it cannot parse and leaves it out', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: [unclosed\n---\n')
    const board = readBoard(project)
    expect(board.campaigns[0].children).toEqual([])
    expect(board.findings).toHaveLength(1)
    expect(board.findings[0].folderPath).toBe('campaigns/q3/missions/m1')
  })

  // reason: `renderBoard` prints one finding per line on the assumption that
  // `Finding.says` is one line — js-yaml's own `message` appends a source
  // snippet with newlines and a caret, which would misalign the whole block.
  it('keeps a parse finding to one line, even though js-yaml wants to add a snippet', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: [unclosed\n---\n')
    const board = readBoard(project)
    expect(board.findings[0].says).not.toContain('\n')
  })

  // reason: a board whose columns are whatever anyone typed is not a board.
  it('reports a status that is not one of the five', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nstatus: inprogress\n---\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('inprogress'))).toBe(true)
  })

  // reason: `status` and `subtype` are interpolated straight from the file, so
  // a value carrying a newline would turn one finding into two lines an agent
  // reads as two findings — the same one-line promise `yamlFailureReason`
  // already guarantees for a parse failure.
  it('keeps a bad-status finding to one line, even when the status itself has a newline', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nstatus: "one\\ntwo"\n---\n')
    const board = readBoard(project)
    const finding = board.findings.find((f) => f.folderPath === 'campaigns/q3')
    expect(finding).toBeDefined()
    expect(finding?.says).not.toContain('\n')
  })

  it('keeps a stray-status-on-a-test finding to one line', () => {
    put('tests/login', 'test.md', '---\nname: Login\nstatus: "one\\ntwo"\n---\n')
    const board = readBoard(project)
    const finding = board.findings.find((f) => f.folderPath === 'tests/login')
    expect(finding).toBeDefined()
    expect(finding?.says).not.toContain('\n')
  })

  it('keeps a mismatched-subtype finding to one line', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nsubtype: "one\\ntwo"\n---\n')
    const board = readBoard(project)
    const finding = board.findings.find((f) => f.folderPath === 'campaigns/q3' && f.says.includes('subtype'))
    expect(finding).toBeDefined()
    expect(finding?.says).not.toContain('\n')
  })

  it('keeps a stray-subtype-on-a-bug finding to one line', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/bugs/b1', 'bug.md', '---\nname: B1\nsubtype: "one\\ntwo"\n---\n')
    const board = readBoard(project)
    const finding = board.findings.find((f) => f.folderPath === 'campaigns/q3/bugs/b1' && f.says.includes('subtype'))
    expect(finding).toBeDefined()
    expect(finding?.says).not.toContain('\n')
  })

  // reason: a task with no checkable definition of done cannot be gated, and
  // gating is the point. Reported, never refused.
  it('reports a task with no acceptance criteria, and still reads it', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: M1\n---\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.md', '---\nname: T1\n---\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('acceptance criterion'))).toBe(true)
    expect(board.campaigns[0].children[0].children).toHaveLength(1)
  })

  // reason: progress is computed and shown; it is never written. This is the
  // rule the whole design is defined against.
  it('counts progress without touching any status', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nstatus: idea\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: M1\nstatus: idea\n---\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.md', '---\nname: T1\nstatus: done\n---\n')
    put('campaigns/q3/missions/m1/tasks/t2', 'workitem.md', '---\nname: T2\nstatus: idea\n---\n')
    const board = readBoard(project)
    const mission = board.campaigns[0].children[0]
    expect(mission.progress).toEqual({ done: 1, total: 2 })
    // The mission's own status is what its file says, whatever its children do.
    expect(mission.status).toBe('idea')
    expect(board.campaigns[0].status).toBe('idea')
  })

  // reason: the case the mission-with-an-idea-child test above can't catch —
  // every child done, at both levels. A rollup that only fires on full
  // completion (children.every(...)) is a no-op on a partial mission, so the
  // rule needs a fixture where completion actually is full, for the mission
  // and for the campaign above it, or a rollup can hide behind "all tests pass."
  it('keeps a parent status as its file declares it, even when every child is done', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nstatus: idea\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: M1\nstatus: idea\n---\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.md', '---\nname: T1\nstatus: done\n---\n')
    put('campaigns/q3/missions/m1/tasks/t2', 'workitem.md', '---\nname: T2\nstatus: done\n---\n')
    const board = readBoard(project)
    const campaign = board.campaigns[0]
    const mission = campaign.children[0]
    // Every task is done, and still neither parent's status moved.
    expect(mission.status).toBe('idea')
    expect(campaign.status).toBe('idea')
    // Progress reports the same completion that status must not adopt.
    expect(mission.progress).toEqual({ done: 2, total: 2 })
    expect(campaign.progress).toEqual({ done: 0, total: 1 })
  })

  // reason: readBoard only ever descends into `campaigns/`, so a `.trash` at
  // the board root is never a candidate regardless of the filter — this has
  // to plant one where readBoard actually looks, or deleting the filter would
  // leave the test passing for the wrong reason.
  it("never reads a .trash folder found while listing an entity's children", () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/missions/.trash', 'workitem.md', '---\nname: Gone\n---\n')
    expect(readBoard(project).campaigns[0].children).toEqual([])
  })

  it('sorts by slug so two reads of one board agree', () => {
    put('campaigns/b', 'workitem.md', '---\nname: B\n---\n')
    put('campaigns/a', 'workitem.md', '---\nname: A\n---\n')
    expect(readBoard(project).campaigns.map((c) => c.slug)).toEqual(['a', 'b'])
  })
})

describe('reading .md, and the .yaml that came before', () => {
  it('reads an entity folder holding workitem.md from it', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nstatus: executing\n---\n\nA quarter of work.\n')
    const board = readBoard(project)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].status).toBe('executing')
    expect(board.campaigns[0].fields.description).toBe('A quarter of work.')
    expect(board.findings).toEqual([])
  })

  // reason: a board nobody has converted yet must keep reading, with its
  // prose still folded into a YAML string.
  it('reads an entity folder holding only workitem.yaml, through loadLegacyEntity', () => {
    put(
      'campaigns/q3',
      'workitem.yaml',
      'name: Q3\ndescription: A quarter of work.\nacceptance_criteria:\n  - text: Ship it\n    done: true\n',
    )
    const board = readBoard(project)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].fields.description).toBe('A quarter of work.')
    expect(board.campaigns[0].fields.acceptanceCriteria).toEqual([{ text: 'Ship it', done: true }])
    expect(board.findings).toEqual([])
  })

  // reason: a conversion in progress, or one that stalled, is not an error —
  // but the board reads only one of the two, and a person editing the wrong
  // one deserves to be told which file won.
  it('reads from the .md and reports the .yaml as ignored, when a folder holds both', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3 from md\n---\n')
    put('campaigns/q3', 'workitem.yaml', 'name: Q3 from yaml\n')
    const board = readBoard(project)
    expect(board.campaigns[0].name).toBe('Q3 from md')
    expect(board.findings).toEqual([
      { folderPath: 'campaigns/q3', says: 'workitem.yaml is ignored; workitem.md is what the board reads' },
    ])
  })

  // reason: reading never repairs. A malformed .md is a finding naming it,
  // and an entity that is simply absent — same promise a malformed .yaml
  // already keeps.
  it('reports a malformed .md and leaves it out', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: [unclosed\n---\n')
    const board = readBoard(project)
    expect(board.campaigns).toEqual([])
    expect(board.findings).toHaveLength(1)
    expect(board.findings[0].folderPath).toBe('campaigns/q3')
    expect(board.findings[0].says).not.toContain('\n')
  })

  // reason: the fallback has an error branch of its own, and it is the one a
  // board nobody has converted actually reaches — a corrupted `.yaml` with no
  // `.md` beside it. It must name the file it could not read, leave the entity
  // off the board, and repair nothing.
  it('reports a malformed legacy .yaml, naming it, and leaves it out', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: [unclosed\n')
    const board = readBoard(project)
    expect(board.campaigns).toEqual([])
    expect(board.findings).toHaveLength(1)
    expect(board.findings[0].folderPath).toBe('campaigns/q3')
    expect(board.findings[0].says).toContain('workitem.yaml could not be read')
    expect(board.findings[0].says).not.toContain('\n')
    expect(readFileSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'workitem.yaml'), 'utf8')).toBe(
      'name: [unclosed\n',
    )
    expect(existsSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'workitem.md'))).toBe(false)
  })
})

describe('findEntity', () => {
  it('finds an entity anywhere in the tree by its folder path', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: M1\n---\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.md', '---\nname: T1\n---\n')
    const board = readBoard(project)
    expect(findEntity(board, 'campaigns/q3/missions/m1/tasks/t1')?.name).toBe('T1')
    expect(findEntity(board, 'campaigns/nope')).toBeUndefined()
  })
})

describe('a folder holding the wrong type of file', () => {
  // reason: empty is legitimate — a candidate directory nobody has filled in
  // yet — but holding a bug.md where a campaign's workitem.md belongs is not
  // empty, it is mislabeled, and the spec promises a finding naming it rather
  // than letting the whole subtree vanish.
  it('reports a campaign folder holding a bug.md instead of a workitem.md', () => {
    put('campaigns/q3', 'bug.md', '---\nname: Q3\n---\n')
    const board = readBoard(project)
    expect(board.campaigns).toEqual([])
    expect(board.findings.some((f) => f.folderPath === 'campaigns/q3' && f.says.includes('bug.md'))).toBe(true)
  })

  // reason: readSuite falls through the same readEntity check, so a directory
  // holding a workitem.md under tests/ is not a test — `readSuite` walks it
  // as a suite instead, and the finding has to say that rather than claiming
  // "this folder is a test", which the walk that follows does not honor.
  it('reports a tests folder holding a workitem.md instead of a test.md, and walks it as a suite', () => {
    put('tests/login', 'workitem.md', '---\nname: Login\n---\n')
    const board = readBoard(project)
    expect(board.tests.tests).toEqual([])
    expect(board.tests.suites.some((s) => s.slug === 'login')).toBe(true)
    expect(
      board.findings.some((f) => f.folderPath === 'tests/login' && f.says.includes('workitem.md') && f.says.includes('suite')),
    ).toBe(true)
  })

  // reason: "holds a test.md is a test, full stop" must not also make the
  // subdirectories beside it disappear without a word.
  it('reports a test directory that also holds subdirectories, and does not walk them', () => {
    put('tests/login', 'test.md', '---\nname: Login\n---\n')
    mkdirSync(join(project, '.dsh', 'tasks', 'tests', 'login', 'extra'), { recursive: true })
    const board = readBoard(project)
    expect(board.tests.tests.map((t) => t.name)).toEqual(['Login'])
    expect(board.tests.suites).toEqual([])
    const says = board.findings.find((f) => f.folderPath === 'tests/login')?.says ?? ''
    expect(says).toContain('subdirector')
    // A person reads this and goes looking for the file it names, so it names
    // the one the board actually read — and `Finding.says` is one line.
    expect(says).toContain('test.md')
    expect(says).not.toContain('test.yaml')
    expect(says).not.toContain('\n')
  })

  // reason: either format makes the folder a test, so the same finding is
  // reached on a board nobody has converted — where the file it must name is
  // the only one on disk.
  it('names the yaml in that finding when the test is still a legacy one', () => {
    put('tests/login', 'test.yaml', 'name: Login\n')
    mkdirSync(join(project, '.dsh', 'tasks', 'tests', 'login', 'extra'), { recursive: true })
    const board = readBoard(project)
    expect(board.tests.tests.map((t) => t.name)).toEqual(['Login'])
    const says = board.findings.find((f) => f.folderPath === 'tests/login')?.says ?? ''
    expect(says).toContain('holds test.yaml and subdirectories')
    expect(says).not.toContain('\n')
  })

  // reason: preserved through extra on a round-trip, correctly — but never
  // reported, which was not correct given "a test has no status" is called
  // out as the one asymmetry in the model.
  it('reports a status field on a test', () => {
    put('tests/login', 'test.md', '---\nname: Login\nstatus: idea\n---\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.folderPath === 'tests/login' && f.says.includes('status'))).toBe(true)
  })

  it('reports a subtype field on a bug', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    put('campaigns/q3/bugs/b1', 'bug.md', '---\nname: B1\nsubtype: task\n---\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.folderPath === 'campaigns/q3/bugs/b1' && f.says.includes('subtype'))).toBe(true)
  })

  it('reports a subtype field on a test', () => {
    put('tests/login', 'test.md', '---\nname: Login\nsubtype: task\n---\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.folderPath === 'tests/login' && f.says.includes('subtype'))).toBe(true)
  })
})

describe('findTest', () => {
  it('finds a test at any depth in the tests container', () => {
    put('tests/auth/oauth/callback', 'test.md', '---\nname: Callback\n---\n')
    const board = readBoard(project)
    expect(findTest(board.tests, 'tests/auth/oauth/callback')?.name).toBe('Callback')
    expect(findTest(board.tests, 'tests/gone')).toBeUndefined()
  })
})

describe('reading the three types', () => {
  it('reads a campaign, a mission and a task as workitems at their own levels', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nsubtype: campaign\nstatus: executing\n---\n')
    put('campaigns/q3/missions/m1', 'workitem.md', '---\nname: M1\nsubtype: mission\n---\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.md', '---\nname: T1\nsubtype: task\nstatus: done\n---\n')
    const board = readBoard(project)
    expect(board.campaigns[0].level).toBe('campaign')
    expect(board.campaigns[0].children[0].level).toBe('mission')
    expect(board.campaigns[0].children[0].children[0].level).toBe('task')
  })

  // reason: the path is what the reader walks, so it decides. The key is what
  // the file claims, and a claim that disagrees with where it sits is worth
  // saying out loud rather than quietly overruling.
  it('trusts the path over a subtype that disagrees, and reports the disagreement', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nsubtype: mission\n---\n')
    const board = readBoard(project)
    expect(board.campaigns[0].level).toBe('campaign')
    expect(board.findings.some((f) => f.says.includes('subtype'))).toBe(true)
  })

  it('reports nothing when the subtype is simply absent', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    expect(readBoard(project).findings).toEqual([])
  })
})

describe('reading tests', () => {
  it('reads a test at the root of the tests container', () => {
    put('tests/login', 'test.md', '---\nname: Login\n---\n')
    const board = readBoard(project)
    expect(board.tests.tests.map((t) => t.name)).toEqual(['Login'])
    expect(board.tests.tests[0].folderPath).toBe('tests/login')
  })

  // reason: a suite is a directory and nothing else, so depth is free and a
  // directory holding no test.md is a suite rather than a broken test.
  it('reads nested suites to any depth', () => {
    put('tests/auth/oauth/callback', 'test.md', '---\nname: Callback\n---\n')
    const board = readBoard(project)
    expect(board.tests.suites.map((s) => s.slug)).toEqual(['auth'])
    expect(board.tests.suites[0].suites[0].slug).toBe('oauth')
    expect(board.tests.suites[0].suites[0].tests[0].name).toBe('Callback')
  })

  it('gives a test no status, because it is not work in flight', () => {
    put('tests/login', 'test.md', '---\nname: Login\n---\n')
    expect(readBoard(project).tests.tests[0].status).toBe('')
  })

  it('reports a project with tests but no campaigns without failing', () => {
    put('tests/login', 'test.md', '---\nname: Login\n---\n')
    const board = readBoard(project)
    expect(board.present).toBe(true)
    expect(board.campaigns).toEqual([])
  })

  it('answers with an empty tests root when there are none', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\n---\n')
    expect(readBoard(project).tests).toEqual({ path: 'tests', slug: 'tests', suites: [], tests: [] })
  })
})

describe('findings about links', () => {
  beforeEach(() => {
    put('tests/login', 'test.md', '---\nname: Login\n---\n')
  })

  it('says nothing about a link that resolves', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nvalidated_by:\n  - test: tests/login\n    result: pass\n---\n')
    expect(readBoard(project).findings).toEqual([])
  })

  // reason: a validated_by entry that quietly vanished would turn "this is
  // proven" into "this was proven once" with nothing to say so.
  it('reports a link naming a test that is not there', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nvalidated_by:\n  - test: tests/gone\n    result: pass\n---\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('tests/gone'))).toBe(true)
  })

  it('reports a result that is not one of the three', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nvalidated_by:\n  - test: tests/login\n    result: green\n---\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('green'))).toBe(true)
  })

  // reason: a failure nobody wrote down should not read as fine.
  it('reports a failing link with no bug against it', () => {
    put('campaigns/q3', 'workitem.md', '---\nname: Q3\nvalidated_by:\n  - test: tests/login\n    result: fail\n---\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('no bug'))).toBe(true)
  })

  it('says nothing about a failing link that names one', () => {
    put('campaigns/q3/bugs/b1', 'bug.md', '---\nname: B1\n---\n')
    put(
      'campaigns/q3',
      'workitem.md',
      '---\nname: Q3\nvalidated_by:\n  - test: tests/login\n    result: fail\n    bug: campaigns/q3/bugs/b1\n---\n',
    )
    expect(readBoard(project).findings).toEqual([])
  })
})
