import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBoard } from './board-read'
import {
  addCriterion,
  createEntity,
  linkTest,
  recordRun,
  setStatus,
  tickCriterion,
  trashEntity,
  unlinkTest,
  updateEntity,
} from './board-write'

let project = ''
beforeEach(() => {
  // Not realpath'd. resolveInBoard resolves both the target and the board
  // root through the nearest existing ancestor now, so a project root that
  // itself sits under a symlink — tmpdir() on macOS is one, /var -> /private/var
  // — agrees with itself without the fixture pre-canonicalizing it. Leaving
  // this un-hoisted is what proves that fix: it hid the bug this fixed.
  project = mkdtempSync(join(tmpdir(), 'dsh-board-'))
  mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/** The YAML on disk for one folder path. */
function read(folderPath: string, file: string): string {
  return readFileSync(join(project, '.dsh', 'tasks', folderPath, file), 'utf8')
}

describe('createEntity', () => {
  it('creates a campaign from its name', () => {
    const out = createEntity(project, 'campaign', '', 'Q3 Launch')
    expect(out).toEqual({ ok: true, folderPath: 'campaigns/q3-launch' })
    expect(read('campaigns/q3-launch', 'workitem.yaml')).toContain('name: Q3 Launch')
    expect(read('campaigns/q3-launch', 'workitem.yaml')).toContain('status: draft')
  })

  it('nests a mission and a task under their parents', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const mission = createEntity(project, 'mission', 'campaigns/q3', 'M1 Auth')
    expect(mission).toEqual({ ok: true, folderPath: 'campaigns/q3/missions/m1-auth' })
    const task = createEntity(project, 'task', 'campaigns/q3/missions/m1-auth', 'T1 Login')
    expect(task).toEqual({ ok: true, folderPath: 'campaigns/q3/missions/m1-auth/tasks/t1-login' })
  })

  it('creates a bug under a campaign and under a mission', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(createEntity(project, 'bug', 'campaigns/q3', 'Crash')).toMatchObject({
      folderPath: 'campaigns/q3/bugs/crash',
    })
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    expect(createEntity(project, 'bug', 'campaigns/q3/missions/m1', 'Leak')).toMatchObject({
      folderPath: 'campaigns/q3/missions/m1/bugs/leak',
    })
  })

  // reason: two entities with one name is ordinary, and a create that silently
  // overwrote the first would destroy a plan.
  it('numbers a slug that is already taken rather than overwriting', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(createEntity(project, 'campaign', '', 'Q3')).toEqual({ ok: true, folderPath: 'campaigns/q3-2' })
    expect(readBoard(project).campaigns).toHaveLength(2)
  })

  it('refuses a blank name, which has no slug', () => {
    expect(createEntity(project, 'campaign', '', '   ')).toEqual({ ok: false, reason: 'Name the campaign first.' })
  })

  it('refuses a parent that does not exist', () => {
    expect(createEntity(project, 'mission', 'campaigns/nope', 'M1')).toEqual({
      ok: false,
      reason: 'campaigns/nope is not on the board.',
    })
  })

  it('refuses a parent of the wrong kind', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    expect(createEntity(project, 'mission', 'campaigns/q3/missions/m1', 'M2').ok).toBe(false)
  })
})

describe('updateEntity', () => {
  it('changes the fields it is given and leaves the rest', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(updateEntity(project, 'campaigns/q3', { description: 'ship it' }).ok).toBe(true)
    const text = read('campaigns/q3', 'workitem.yaml')
    expect(text).toContain('description: ship it')
    expect(text).toContain('name: Q3')
  })

  // reason: the regression that motivated `extra` upstream — an agent's own
  // key must survive an edit made by something that has never heard of it.
  it('keeps a key the schema does not model', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const file = join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'workitem.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}owner: alice\n`)
    updateEntity(project, 'campaigns/q3', { description: 'changed' })
    expect(read('campaigns/q3', 'workitem.yaml')).toContain('owner: alice')
  })

  // reason: the one rule the whole design is defined against.
  it('never changes a parent status when a child is written', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    createEntity(project, 'task', 'campaigns/q3/missions/m1', 'T1')
    setStatus(project, 'campaigns/q3/missions/m1/tasks/t1', 'done')
    const board = readBoard(project)
    expect(board.campaigns[0].status).toBe('draft')
    expect(board.campaigns[0].children[0].status).toBe('draft')
    expect(board.campaigns[0].children[0].progress).toEqual({ done: 1, total: 1 })
  })
})

describe('setStatus', () => {
  it('moves an entity to a status', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(setStatus(project, 'campaigns/q3', 'executing').ok).toBe(true)
    expect(read('campaigns/q3', 'workitem.yaml')).toContain('status: executing')
  })

  it('refuses a status the board does not know', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const out = setStatus(project, 'campaigns/q3', 'inprogress')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('draft, executing, awaitingApproval, done, failed, cancelled')
    expect(read('campaigns/q3', 'workitem.yaml')).toContain('status: draft')
  })
})

describe('criteria', () => {
  beforeEach(() => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    createEntity(project, 'task', 'campaigns/q3/missions/m1', 'T1')
  })

  it('adds a criterion unticked', () => {
    expect(addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 'it works').ok).toBe(true)
    const text = read('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml')
    expect(text).toContain('text: it works')
    expect(text).toContain('done: false')
  })

  it('ticks one by position', () => {
    addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 'first')
    addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 'second')
    expect(tickCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 1, true).ok).toBe(true)
    const board = readBoard(project)
    const task = board.campaigns[0].children[0].children[0]
    expect(task.fields.acceptanceCriteria.map((c) => c.done)).toEqual([false, true])
  })

  it('refuses a position that is not there', () => {
    const out = tickCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 4, true)
    expect(out.ok).toBe(false)
  })

  it('refuses a blank criterion, which cannot be checked', () => {
    expect(addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', '  ').ok).toBe(false)
  })
})

describe('trashEntity', () => {
  // reason: a board entity carries the plan and the acceptance criteria for
  // real work. A delete recoverable only through git's reflog is one nobody
  // recovers.
  it('moves the folder to the trash rather than removing it', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(trashEntity(project, 'campaigns/q3').ok).toBe(true)
    expect(existsSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3'))).toBe(false)
    expect(readBoard(project).campaigns).toEqual([])
    // reason: a directory existing is not evidence of a move — trashEntity
    // creates .trash before it acts, so that much is true of a delete too.
    // The folder's own file, still readable under its original path beneath
    // .trash, is what only a move produces.
    const trashed = join(project, '.dsh', 'tasks', '.trash', 'campaigns', 'q3')
    expect(existsSync(trashed)).toBe(true)
    expect(readFileSync(join(trashed, 'workitem.yaml'), 'utf8')).toContain('name: Q3')
  })

  it('takes the children with it', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    trashEntity(project, 'campaigns/q3')
    expect(readBoard(project).campaigns).toEqual([])
    // reason: an empty board is also what a delete would leave — the mission's
    // file, still readable under the trashed campaign, is what only a move
    // (of the whole subtree) produces.
    const trashedMission = join(project, '.dsh', 'tasks', '.trash', 'campaigns', 'q3', 'missions', 'm1')
    expect(readFileSync(join(trashedMission, 'workitem.yaml'), 'utf8')).toContain('name: M1')
  })

  // reason: trashing twice is ordinary — two agents, one stale board — and the
  // second must not destroy what the first put there.
  it('does not overwrite an entity already in the trash under that name', () => {
    createEntity(project, 'campaign', '', 'Q3')
    trashEntity(project, 'campaigns/q3')
    createEntity(project, 'campaign', '', 'Q3')
    expect(trashEntity(project, 'campaigns/q3').ok).toBe(true)
    const trash = join(project, '.dsh', 'tasks', '.trash', 'campaigns')
    expect(existsSync(join(trash, 'q3'))).toBe(true)
    expect(existsSync(join(trash, 'q3-2'))).toBe(true)
  })

  // reason: resolveInBoard refuses the trash outright, so it never gets a
  // chance to catch a symlinked one — trashEntity computes its own
  // destination with no boundary check, and mkdirSync/renameSync would follow
  // the symlink and move the entity's whole subtree out of the repository.
  it('refuses a .trash that is a symlink, rather than moving the entity through it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    symlinkSync(outside, join(project, '.dsh', 'tasks', '.trash'))
    createEntity(project, 'campaign', '', 'Q3')
    const out = trashEntity(project, 'campaigns/q3')
    expect(out.ok).toBe(false)
    expect(existsSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3'))).toBe(true)
    expect(existsSync(join(outside, 'campaigns'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  // reason: `.trash` itself being a symlink is only half the escape. `into`
  // is built from the entity's own parent path reconstructed under `.trash`
  // (`.trash/campaigns/...`), so a symlink one directory deeper — with
  // `.trash` a real directory — still walks mkdirSync/renameSync out of the
  // repository while the caller sees `ok: true`.
  it('refuses a real .trash whose campaigns subdirectory is a symlink out', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    mkdirSync(join(project, '.dsh', 'tasks', '.trash'), { recursive: true })
    symlinkSync(outside, join(project, '.dsh', 'tasks', '.trash', 'campaigns'))
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    const out = trashEntity(project, 'campaigns/q3/missions/m1')
    expect(out.ok).toBe(false)
    expect(existsSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'missions', 'm1'))).toBe(true)
    expect(existsSync(join(outside, 'q3'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })
})

describe('creating a test', () => {
  it('puts a test in the tests container', () => {
    expect(createEntity(project, 'test', '', 'Login happy path')).toEqual({
      ok: true,
      folderPath: 'tests/login-happy-path',
    })
    expect(read('tests/login-happy-path', 'test.yaml')).toContain('name: Login happy path')
  })

  it('puts a test inside a suite when one is named', () => {
    expect(createEntity(project, 'test', 'tests/auth', 'Login')).toEqual({ ok: true, folderPath: 'tests/auth/login' })
  })

  it('creates the suite directories a nested parent implies', () => {
    expect(createEntity(project, 'test', 'tests/auth/oauth', 'Callback')).toMatchObject({
      folderPath: 'tests/auth/oauth/callback',
    })
    expect(readBoard(project).tests.suites[0].suites[0].tests[0].name).toBe('Callback')
  })

  // reason: a test has no status, so writing one would put it in a column it
  // does not belong in.
  it('writes no status on a test', () => {
    createEntity(project, 'test', '', 'Login')
    expect(read('tests/login', 'test.yaml')).not.toContain('status')
  })

  it('refuses a suite path outside the tests container', () => {
    expect(createEntity(project, 'test', 'campaigns/q3', 'Login').ok).toBe(false)
  })
})

describe('linkTest', () => {
  beforeEach(() => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'test', '', 'Login')
  })

  it('records a verdict on the workitem, not on the test', () => {
    expect(linkTest(project, 'campaigns/q3', 'tests/login', 'pass', '').ok).toBe(true)
    expect(read('campaigns/q3', 'workitem.yaml')).toContain('test: tests/login')
    expect(read('campaigns/q3', 'workitem.yaml')).toContain('result: pass')
    expect(read('tests/login', 'test.yaml')).not.toContain('campaigns/q3')
  })

  it('carries a comment and a bug', () => {
    createEntity(project, 'bug', 'campaigns/q3', 'Login 500')
    linkTest(project, 'campaigns/q3', 'tests/login', 'fail', 'returns 500', 'campaigns/q3/bugs/login-500')
    const text = read('campaigns/q3', 'workitem.yaml')
    expect(text).toContain('comment: returns 500')
    expect(text).toContain('bug: campaigns/q3/bugs/login-500')
  })

  // reason: linking the same test twice is ordinary — a re-run — and a second
  // entry would leave two verdicts for one pairing with no way to say which.
  it('replaces the verdict when the same test is linked again', () => {
    linkTest(project, 'campaigns/q3', 'tests/login', 'fail', 'first', 'campaigns/q3/bugs/x')
    linkTest(project, 'campaigns/q3', 'tests/login', 'pass', '')
    const links = readBoard(project).campaigns[0].fields.validatedBy
    expect(links).toHaveLength(1)
    expect(links[0].result).toBe('pass')
    // The bug from the old verdict goes with it: it described a failure that
    // is no longer the current answer.
    expect(links[0].bug).toBeUndefined()
  })

  it('refuses a result that is not one of the three', () => {
    const out = linkTest(project, 'campaigns/q3', 'tests/login', 'green', '')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('pass, fail, not_run')
  })

  it('refuses a test that is not on the board', () => {
    expect(linkTest(project, 'campaigns/q3', 'tests/gone', 'pass', '').ok).toBe(false)
  })

  // reason: a bug and a test do not declare what proves them.
  it('refuses to link anything to a bug or a test', () => {
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    expect(linkTest(project, 'campaigns/q3/bugs/crash', 'tests/login', 'pass', '').ok).toBe(false)
    expect(linkTest(project, 'tests/login', 'tests/login', 'pass', '').ok).toBe(false)
  })
})

describe('unlinkTest', () => {
  it('removes the link and leaves the others', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'test', '', 'A')
    createEntity(project, 'test', '', 'B')
    linkTest(project, 'campaigns/q3', 'tests/a', 'pass', '')
    linkTest(project, 'campaigns/q3', 'tests/b', 'pass', '')
    expect(unlinkTest(project, 'campaigns/q3', 'tests/a').ok).toBe(true)
    expect(readBoard(project).campaigns[0].fields.validatedBy.map((l) => l.test)).toEqual(['tests/b'])
  })

  it('refuses a test that was never linked, rather than reporting success', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(unlinkTest(project, 'campaigns/q3', 'tests/never').ok).toBe(false)
  })
})

describe('recordRun', () => {
  beforeEach(() => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'test', '', 'Login')
  })

  it('appends a run to the test, not to the workitem', () => {
    expect(recordRun(project, 'tests/login', 'campaigns/q3', 'pass', '2026-09-05T09:00:00Z').ok).toBe(true)
    const runs = readBoard(project).tests.tests[0].fields.runs
    expect(runs).toEqual([{ at: '2026-09-05T09:00:00Z', workitem: 'campaigns/q3', result: 'pass' }])
    expect(read('campaigns/q3', 'workitem.yaml')).not.toContain('runs')
  })

  // reason: the run history is what makes flakiness visible, so a second run
  // of the same test against the same workitem is the whole point.
  it('keeps every run rather than replacing the last', () => {
    recordRun(project, 'tests/login', 'campaigns/q3', 'pass', 'a')
    recordRun(project, 'tests/login', 'campaigns/q3', 'fail', 'b')
    expect(readBoard(project).tests.tests[0].fields.runs.map((r) => r.result)).toEqual(['pass', 'fail'])
  })

  // reason: recording a run must not silently change the verdict — a verdict
  // is a claim with an author, and an automatic run is not one.
  it('does not touch the workitem it names', () => {
    linkTest(project, 'campaigns/q3', 'tests/login', 'pass', '')
    recordRun(project, 'tests/login', 'campaigns/q3', 'fail', 'a')
    expect(readBoard(project).campaigns[0].fields.validatedBy[0].result).toBe('pass')
  })

  it('refuses a result that is not one of the three', () => {
    expect(recordRun(project, 'tests/login', 'campaigns/q3', 'green', 'a').ok).toBe(false)
  })

  it('refuses a folder that is not a test', () => {
    expect(recordRun(project, 'campaigns/q3', 'campaigns/q3', 'pass', 'a').ok).toBe(false)
  })
})

describe('every write', () => {
  // reason: this is the boundary. A folder path arrives from the agent's tools.
  it('refuses a folder path that climbs out of the board', () => {
    expect(setStatus(project, '../../../etc', 'done').ok).toBe(false)
    expect(updateEntity(project, '../..', { name: 'x' }).ok).toBe(false)
    expect(trashEntity(project, '../..').ok).toBe(false)
    expect(createEntity(project, 'mission', '../..', 'M1').ok).toBe(false)
  })
})
