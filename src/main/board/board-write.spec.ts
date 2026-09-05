import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  type WriteResult,
} from './board-write'
import { RUN_HISTORY } from './entity-schema'

/** Flipped by the ordering test so one write, and only that one, fails. */
const disk = vi.hoisted(() => ({ writeThrows: false }))

// reason: the conversion's whole safety argument is an ordering — the markdown
// is on disk before the `.yaml` it replaces is removed — and an ordering is
// only provable by making the first half fail. Every other test in this file
// runs the real write, so the mock is a passthrough unless a test asks for it.
vi.mock('../atomic-write', async () => {
  const actual = await vi.importActual<typeof import('../atomic-write')>('../atomic-write')
  return {
    writeFileAtomic: (filePath: string, contents: string, mode?: number): void => {
      if (disk.writeThrows) throw new Error('no space left on device')
      actual.writeFileAtomic(filePath, contents, mode)
    },
  }
})

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
  disk.writeThrows = false
  rmSync(project, { recursive: true, force: true })
})

/** The markdown on disk for one folder path. */
function read(folderPath: string, file: string): string {
  return readFileSync(join(project, '.dsh', 'tasks', folderPath, file), 'utf8')
}

/** Whether a folder holds a file at all — what a conversion is judged by. */
function has(folderPath: string, file: string): boolean {
  return existsSync(join(project, '.dsh', 'tasks', folderPath, file))
}

/**
 * Put an entity on the board in the format that came before, the way a board
 * nobody has converted holds one: a `<type>.yaml` and no markdown beside it.
 */
function putLegacy(folderPath: string, file: string, body: string): void {
  mkdirSync(join(project, '.dsh', 'tasks', folderPath), { recursive: true })
  writeFileSync(join(project, '.dsh', 'tasks', folderPath, file), body)
}

/** A campaign and a test, both stored the way the board stored them before. */
function legacyBoard(): void {
  putLegacy(
    'campaigns/q3',
    'workitem.yaml',
    'name: Q3\nsubtype: campaign\nstatus: idea\ndescription: ship it\n' +
      'acceptance_criteria:\n  - text: it works\n    done: false\n' +
      "validated_by:\n  - test: tests/login\n    result: pass\n    comment: ''\n",
  )
  putLegacy('tests/login', 'test.yaml', 'name: Login\nsteps: open the login page\n')
}

describe('createEntity', () => {
  it('creates a campaign from its name', () => {
    const out = createEntity(project, 'campaign', '', 'Q3 Launch')
    expect(out).toEqual({ ok: true, folderPath: 'campaigns/q3-launch' })
    expect(read('campaigns/q3-launch', 'workitem.md')).toContain('name: Q3 Launch')
    expect(read('campaigns/q3-launch', 'workitem.md')).toContain('status: idea')
  })

  // reason: a create has nothing to convert, so it must write the format the
  // board reads and never the one it only falls back to.
  it('writes a markdown document and never the yaml that came before', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    createEntity(project, 'test', '', 'Login')
    expect(has('campaigns/q3', 'workitem.md')).toBe(true)
    expect(has('campaigns/q3', 'workitem.yaml')).toBe(false)
    // The positive beside each negative: absent `.yaml` is also what a create
    // that wrote nothing at all for these two levels would look like.
    expect(has('campaigns/q3/bugs/crash', 'bug.md')).toBe(true)
    expect(has('campaigns/q3/bugs/crash', 'bug.yaml')).toBe(false)
    expect(has('tests/login', 'test.md')).toBe(true)
    expect(has('tests/login', 'test.yaml')).toBe(false)
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

  it('refuses a parent of the wrong level', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    expect(createEntity(project, 'mission', 'campaigns/q3/missions/m1', 'M2').ok).toBe(false)
  })
})

describe('updateEntity', () => {
  it('changes the fields it is given and leaves the rest', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(updateEntity(project, 'campaigns/q3', { description: 'ship it' }).ok).toBe(true)
    const text = read('campaigns/q3', 'workitem.md')
    // The description is the document's lead, before the first heading — not a
    // key. A file still carrying `description:` would be one the writer never
    // converted.
    expect(text).toContain('\nship it\n')
    expect(text).not.toContain('description:')
    expect(text).toContain('name: Q3')
  })

  // reason: the regression that motivated `extra` upstream — an agent's own
  // key must survive an edit made by something that has never heard of it.
  it('keeps a key the schema does not model', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const file = join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'workitem.md')
    // Into the frontmatter, not onto the end of the file: an unmodelled key
    // lives where the modelled ones do, and appending after the body would be
    // adding prose rather than a key.
    writeFileSync(file, readFileSync(file, 'utf8').replace('---\n\n', 'owner: alice\n---\n\n'))
    updateEntity(project, 'campaigns/q3', { description: 'changed' })
    expect(read('campaigns/q3', 'workitem.md')).toContain('owner: alice')
  })

  // reason: the one rule the whole design is defined against.
  it('never changes a parent status when a child is written', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    createEntity(project, 'task', 'campaigns/q3/missions/m1', 'T1')
    setStatus(project, 'campaigns/q3/missions/m1/tasks/t1', 'done')
    const board = readBoard(project)
    expect(board.campaigns[0].status).toBe('idea')
    expect(board.campaigns[0].children[0].status).toBe('idea')
    expect(board.campaigns[0].children[0].progress).toEqual({ done: 1, total: 1 })
  })
})

describe('setStatus', () => {
  it('moves an entity to a status', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(setStatus(project, 'campaigns/q3', 'executing').ok).toBe(true)
    expect(read('campaigns/q3', 'workitem.md')).toContain('status: executing')
  })

  it('refuses a status the board does not know', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const out = setStatus(project, 'campaigns/q3', 'inprogress')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('idea, backlog, executing, validation, done')
    expect(read('campaigns/q3', 'workitem.md')).toContain('status: idea')
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
    const text = read('campaigns/q3/missions/m1/tasks/t1', 'workitem.md')
    expect(text).toContain('## Acceptance Criteria\n\n- [ ] it works\n')
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

  // reason: `dumpEntity`'s test branch emits no `acceptance_criteria` at all,
  // so a write here would be silently dropped on the way to disk while the
  // caller was told `{ ok: true }` — a refusal converted into a false success.
  it('refuses to add a criterion to a test, with a reason', () => {
    createEntity(project, 'test', '', 'Login')
    const out = addCriterion(project, 'tests/login', 'it works')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('proof')
    expect(read('tests/login', 'test.md')).not.toContain('Acceptance Criteria')
  })

  // reason: a bug's file emits no `acceptance_criteria` either, so the same
  // lie is possible for it — this is not a test-specific guard.
  it('refuses to add a criterion to a bug, with a reason', () => {
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    const out = addCriterion(project, 'campaigns/q3/bugs/crash', 'it works')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('defect report')
    expect(read('campaigns/q3/bugs/crash', 'bug.md')).not.toContain('Acceptance Criteria')
  })

  // reason: the guard is asked of a table, and a table read wrongly refuses
  // every level rather than only the two that have no criteria — which broke
  // board_criterion for tasks, missions and campaigns alike. Both directions
  // have to be pinned, or half of that is invisible.
  it('still adds a criterion to a campaign, a mission and a task', () => {
    expect(addCriterion(project, 'campaigns/q3', 'the campaign works').ok).toBe(true)
    expect(addCriterion(project, 'campaigns/q3/missions/m1', 'the mission works').ok).toBe(true)
    expect(addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 'it works').ok).toBe(true)
    expect(tickCriterion(project, 'campaigns/q3', 0, true).ok).toBe(true)
    expect(read('campaigns/q3', 'workitem.md')).toContain('- [x] the campaign works')
  })

  // reason: a refusal that is only a refusal in the return value is not one.
  // An earlier fix wave produced a version that reported `ok: true` and
  // discarded the write; this pins the file itself, byte for byte.
  it('leaves a bug-s and a test-s file byte-identical when a criterion is refused', () => {
    createEntity(project, 'test', '', 'Login')
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    const beforeTest = read('tests/login', 'test.md')
    const beforeBug = read('campaigns/q3/bugs/crash', 'bug.md')
    expect(addCriterion(project, 'tests/login', 'it works').ok).toBe(false)
    expect(addCriterion(project, 'campaigns/q3/bugs/crash', 'it works').ok).toBe(false)
    expect(tickCriterion(project, 'tests/login', 0, true).ok).toBe(false)
    expect(tickCriterion(project, 'campaigns/q3/bugs/crash', 0, true).ok).toBe(false)
    expect(read('tests/login', 'test.md')).toBe(beforeTest)
    expect(read('campaigns/q3/bugs/crash', 'bug.md')).toBe(beforeBug)
  })

  // reason: the checklist is the criteria's whole storage now, so a tick that
  // rewrote a neighbouring line — or the prose around the section — would be
  // an edit nobody made, in a repository.
  it('ticks exactly one line and leaves the rest of the document byte-identical', () => {
    const task = 'campaigns/q3/missions/m1/tasks/t1'
    updateEntity(project, task, { description: 'the lead paragraph', notes: 'careful here' })
    addCriterion(project, task, 'first')
    addCriterion(project, task, 'second')
    addCriterion(project, task, 'third')
    const before = read(task, 'workitem.md')
    expect(tickCriterion(project, task, 1, true).ok).toBe(true)
    expect(read(task, 'workitem.md')).toBe(before.replace('- [ ] second', '- [x] second'))
  })

  it('refuses to tick a criterion on a test', () => {
    createEntity(project, 'test', '', 'Login')
    expect(tickCriterion(project, 'tests/login', 0, true).ok).toBe(false)
  })

  it('refuses to tick a criterion on a bug', () => {
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    expect(tickCriterion(project, 'campaigns/q3/bugs/crash', 0, true).ok).toBe(false)
  })

  // reason: the two cases above never reach the guard — an entity the board
  // wrote has no criteria at all, so the index-range check refuses first. A
  // legacy `bug.yaml` carrying an `acceptance_criteria` list is the one shape
  // where the guard is the only thing standing between that list and a write
  // `dumpEntity` silently discards, converting the file on the way out.
  it('refuses to tick a criterion a legacy bug carries, where only the guard can refuse', () => {
    putLegacy(
      'campaigns/q3/bugs/crash',
      'bug.yaml',
      'name: Crash\nstatus: idea\nseverity: major\nacceptance_criteria:\n  - text: it works\n    done: false\n',
    )
    const bug = readBoard(project).campaigns[0].children.find((child) => child.level === 'bug')
    // The guard is only reached when the range check passes, so the fixture
    // has to be one the reader really does hand a criterion back for.
    expect(bug?.fields.acceptanceCriteria).toEqual([{ text: 'it works', done: false }])
    const before = read('campaigns/q3/bugs/crash', 'bug.yaml')
    const out = tickCriterion(project, 'campaigns/q3/bugs/crash', 0, true)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('defect report')
    expect(read('campaigns/q3/bugs/crash', 'bug.yaml')).toBe(before)
    expect(has('campaigns/q3/bugs/crash', 'bug.md')).toBe(false)
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
    expect(readFileSync(join(trashed, 'workitem.md'), 'utf8')).toContain('name: Q3')
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
    expect(readFileSync(join(trashedMission, 'workitem.md'), 'utf8')).toContain('name: M1')
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
    expect(read('tests/login-happy-path', 'test.md')).toContain('name: Login happy path')
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
    expect(read('tests/login', 'test.md')).not.toContain('status')
  })

  it('refuses a suite path outside the tests container', () => {
    expect(createEntity(project, 'test', 'campaigns/q3', 'Login').ok).toBe(false)
  })

  // reason: `tests/../campaigns` textually starts with `tests/`, so a lexical
  // check would wave it through — only a resolved comparison catches that it
  // actually names a directory outside the tests container.
  it('refuses a suite path that lexically starts with the tests container but resolves outside it', () => {
    expect(createEntity(project, 'test', 'tests/../campaigns', 'Sneaky').ok).toBe(false)
  })

  // reason: `tests-evil` is a sibling of `tests`, not a child of it, so a bare
  // prefix check must not admit it — the boundary is a path separator, not a
  // shared string prefix.
  it('refuses a suite path that is merely a sibling with a shared prefix', () => {
    expect(createEntity(project, 'test', 'tests-evil/x', 'Sneaky').ok).toBe(false)
  })

  // reason: the tests root itself, named explicitly, is the container and
  // must be accepted just as the empty parent is.
  it('accepts the bare tests root as a suite path', () => {
    expect(createEntity(project, 'test', 'tests', 'Login')).toEqual({ ok: true, folderPath: 'tests/login' })
  })

  // reason: a genuinely nested suite is the ordinary case and must keep
  // working once the check is resolved rather than lexical.
  it('accepts a genuine nested suite path', () => {
    expect(createEntity(project, 'test', 'tests/auth', 'Login')).toEqual({ ok: true, folderPath: 'tests/auth/login' })
  })

  // reason: the fourth instance of the lexical-path bug — `parts` used to come
  // from slicing the caller's raw string, so a spelling this same check had
  // already resolved and accepted still invented the wrong folder.
  it('derives the folder from the resolved suite, not the caller-s spelling of it', () => {
    expect(createEntity(project, 'test', './tests/auth', 'Login')).toEqual({ ok: true, folderPath: 'tests/auth/login' })
  })

  it('derives the folder correctly from a trailing slash on the tests root', () => {
    expect(createEntity(project, 'test', 'tests/', 'Other')).toEqual({ ok: true, folderPath: 'tests/other' })
  })

  // reason: the one non-null assertion on this path that could actually be
  // undefined — `resolveInBoard` answers nothing for a path that resolves to
  // the board root, which is exactly what `tests` symlinked to that root is.
  // The suite still resolves (it is a real directory under the root), so the
  // container is the only thing missing, and the refusal has to say so: told
  // instead that the suite "is not inside the tests container", an agent would
  // go looking at a suite that is fine.
  it('refuses by name when the tests container itself does not resolve', () => {
    rmSync(join(project, '.dsh', 'tasks', 'tests'), { recursive: true, force: true })
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns'), { recursive: true })
    symlinkSync(join(project, '.dsh', 'tasks'), join(project, '.dsh', 'tasks', 'tests'))
    const out = createEntity(project, 'test', 'tests/campaigns', 'Login')
    expect(out).toEqual({ ok: false, reason: "tests is not inside this project's board." })
  })

  // reason: the folder handed back must be the one board_read reports, or the
  // agent's next board_link call for a test it just created is refused.
  it('creates a test through a symlinked suite at the address board_read will report', () => {
    const real = join(project, '.dsh', 'tasks', 'tests', 'real-auth')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, join(project, '.dsh', 'tasks', 'tests', 'auth'))
    expect(createEntity(project, 'test', 'tests/auth', 'Login')).toEqual({ ok: true, folderPath: 'tests/real-auth/login' })
    expect(readBoard(project).tests.suites.find((s) => s.slug === 'real-auth')?.tests[0].folderPath).toBe(
      'tests/real-auth/login',
    )
  })
})

// reason: `open` used to require `findEntity`, which walks campaigns only —
// so every write path through it refused every test, even though board_read
// had just listed one. A test has to be reachable through the same six
// writes a workitem is.
describe('writing a test through the other five paths', () => {
  it('updates steps and expected, and reads them back', () => {
    createEntity(project, 'test', '', 'Login')
    expect(updateEntity(project, 'tests/login', { steps: 'open the login page', expected: 'the dashboard loads' }).ok).toBe(
      true,
    )
    const text = read('tests/login', 'test.md')
    expect(text).toContain('## Steps\n\nopen the login page\n')
    // Where it lands, not merely that it is somewhere in the file: `expected`
    // is not one of `LEVEL_SECTIONS.test`, so `dumpEntity` carries it through
    // the unowned-heading fallback — and a regression that dropped it into the
    // lead or the frontmatter instead would satisfy a bare `toContain`.
    expect(text).toContain('## Expected\n\nthe dashboard loads\n')
    expect(readBoard(project).tests.tests[0].fields.steps).toBe('open the login page')
  })

  // reason: a test's setup and its steps are the document, not two more keys,
  // and the panel reads them off the headings.
  it('writes a test-s sections under their own headings', () => {
    createEntity(project, 'test', '', 'Login')
    expect(updateEntity(project, 'tests/login', { steps: 'click Sign in', preconditions: 'a seeded account' }).ok).toBe(
      true,
    )
    const text = read('tests/login', 'test.md')
    expect(text).toContain('## Preconditions\n\na seeded account\n')
    expect(text).toContain('## Steps\n\nclick Sign in\n')
    const back = readBoard(project).tests.tests[0].fields
    expect(back.preconditions).toBe('a seeded account')
    expect(back.steps).toBe('click Sign in')
  })

  // reason: a test is not work in flight — the instrument work is measured
  // with does not itself move through the columns.
  it('refuses to set a status on a test', () => {
    createEntity(project, 'test', '', 'Login')
    const out = setStatus(project, 'tests/login', 'executing')
    expect(out.ok).toBe(false)
    expect(read('tests/login', 'test.md')).not.toContain('status')
  })

  it('trashes a test', () => {
    createEntity(project, 'test', '', 'Login')
    expect(trashEntity(project, 'tests/login').ok).toBe(true)
    expect(existsSync(join(project, '.dsh', 'tasks', 'tests', 'login'))).toBe(false)
    expect(readBoard(project).tests.tests).toEqual([])
    expect(existsSync(join(project, '.dsh', 'tasks', '.trash', 'tests', 'login'))).toBe(true)
  })
})

describe('linkTest', () => {
  beforeEach(() => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'test', '', 'Login')
  })

  it('records a verdict on the workitem, not on the test', () => {
    expect(linkTest(project, 'campaigns/q3', 'tests/login', 'pass', '').ok).toBe(true)
    expect(read('campaigns/q3', 'workitem.md')).toContain('test: tests/login')
    expect(read('campaigns/q3', 'workitem.md')).toContain('result: pass')
    expect(read('tests/login', 'test.md')).not.toContain('campaigns/q3')
  })

  it('carries a comment and a bug', () => {
    createEntity(project, 'bug', 'campaigns/q3', 'Login 500')
    linkTest(project, 'campaigns/q3', 'tests/login', 'fail', 'returns 500', 'campaigns/q3/bugs/login-500')
    const text = read('campaigns/q3', 'workitem.md')
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

  // reason: mirrors linkTest's own guard. Without it, a stray validated_by on
  // a bug — preserved through extra, never through the typed field a real
  // workitem writes it to — reported ok: true for a change that never
  // touched the file dumpEntity actually re-emits.
  it('refuses to unlink anything from a bug or a test', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    createEntity(project, 'test', '', 'Login')
    expect(unlinkTest(project, 'campaigns/q3/bugs/crash', 'tests/login').ok).toBe(false)
    expect(unlinkTest(project, 'tests/login', 'tests/login').ok).toBe(false)
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
    expect(read('campaigns/q3', 'workitem.md')).not.toContain('runs')
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

  // reason: a run is a record, not prose — it belongs in the frontmatter the
  // schema owns, where the next reader parses it rather than reads it.
  it('writes the run into the frontmatter, above the first heading', () => {
    recordRun(project, 'tests/login', 'campaigns/q3', 'pass', '2026-09-05T09:00:00Z')
    const text = read('tests/login', 'test.md')
    expect(text.slice(0, text.indexOf('## '))).toContain("at: '2026-09-05T09:00:00Z'")
  })

  // reason: the history is what makes flakiness visible, and an uncapped one
  // grows a file nobody can read until the repository notices.
  it('caps the history at RUN_HISTORY, keeping the most recent', () => {
    for (let n = 0; n < RUN_HISTORY + 5; n += 1) {
      recordRun(project, 'tests/login', 'campaigns/q3', 'pass', `run-${String(n)}`)
    }
    const runs = readBoard(project).tests.tests[0].fields.runs
    expect(runs).toHaveLength(RUN_HISTORY)
    expect(runs[0].at).toBe('run-5')
    expect(runs[runs.length - 1].at).toBe(`run-${String(RUN_HISTORY + 4)}`)
  })

  it('refuses a result that is not one of the three', () => {
    expect(recordRun(project, 'tests/login', 'campaigns/q3', 'green', 'a').ok).toBe(false)
  })

  it('refuses a folder that is not a test', () => {
    expect(recordRun(project, 'campaigns/q3', 'campaigns/q3', 'pass', 'a').ok).toBe(false)
  })

  // reason: `readEntity`'s own loadEntity call is guarded; this one was the
  // single exception, and let a YAMLException reach the tool handler as a
  // transport failure instead of a sentence naming the file.
  it('reports a test.md that will not parse, rather than throwing', () => {
    writeFileSync(join(project, '.dsh', 'tasks', 'tests', 'login', 'test.md'), '---\nname: [unclosed\n---\n')
    expect(() => recordRun(project, 'tests/login', 'campaigns/q3', 'pass', 'a')).not.toThrow()
    const out = recordRun(project, 'tests/login', 'campaigns/q3', 'pass', 'a')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('test.md')
  })

  // reason: a board nobody has converted holds only `test.yaml`, and the file
  // this branch names is the one a person has to go and open. Naming `test.md`
  // there would send them to a file that is not on disk at all.
  it('names the yaml, not the markdown, when a legacy test will not parse', () => {
    putLegacy('tests/legacy', 'test.yaml', 'name: [unclosed\n')
    const out = recordRun(project, 'tests/legacy', 'campaigns/q3', 'pass', 'a')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('test.yaml')
    if (!out.ok) expect(out.reason).not.toContain('test.md')
    // Nothing written, and nothing removed: a file that will not parse is not
    // an entity this can convert.
    expect(has('tests/legacy', 'test.md')).toBe(false)
    expect(has('tests/legacy', 'test.yaml')).toBe(true)
  })
})

// reason: the board shipped `<type>.yaml` first, and a board nobody has
// converted must not need a migration pass to keep working. Writing to an
// entity is the conversion: the markdown lands, and the file it replaces goes.
describe('converting a legacy entity', () => {
  const yamlIsGone = (): void => {
    expect(has('campaigns/q3', 'workitem.md')).toBe(true)
    expect(has('campaigns/q3', 'workitem.yaml')).toBe(false)
  }

  const writes: { name: string; run: () => WriteResult }[] = [
    { name: 'updateEntity', run: () => updateEntity(project, 'campaigns/q3', { description: 'changed' }) },
    { name: 'setStatus', run: () => setStatus(project, 'campaigns/q3', 'executing') },
    { name: 'addCriterion', run: () => addCriterion(project, 'campaigns/q3', 'and this too') },
    { name: 'tickCriterion', run: () => tickCriterion(project, 'campaigns/q3', 0, true) },
    { name: 'linkTest', run: () => linkTest(project, 'campaigns/q3', 'tests/login', 'fail', 'broke') },
    { name: 'unlinkTest', run: () => unlinkTest(project, 'campaigns/q3', 'tests/login') },
  ]

  for (const one of writes) {
    it(`converts the file when ${one.name} writes it`, () => {
      legacyBoard()
      expect(one.run().ok).toBe(true)
      yamlIsGone()
    })
  }

  // reason: converting must not cost the entity anything it carried. What the
  // old file said in YAML strings the new one says in the document, and the
  // reader has to get the same entity back either way.
  it('keeps the description, the criteria and the verdict through the conversion', () => {
    legacyBoard()
    expect(setStatus(project, 'campaigns/q3', 'executing').ok).toBe(true)
    const text = read('campaigns/q3', 'workitem.md')
    expect(text).toContain('status: executing')
    expect(text).toContain('\nship it\n')
    expect(text).toContain('## Acceptance Criteria\n\n- [ ] it works\n')
    expect(text).toContain('test: tests/login')
    const back = readBoard(project).campaigns[0]
    expect(back.fields.description).toBe('ship it')
    expect(back.fields.acceptanceCriteria).toEqual([{ text: 'it works', done: false }])
    expect(back.fields.validatedBy[0].test).toBe('tests/login')
    yamlIsGone()
  })

  // reason: `## Acceptance Criteria` is not in the old file at all, so the
  // section has to be written from nothing rather than found and appended to.
  it('creates the criteria section on a legacy file that had none', () => {
    putLegacy('campaigns/q3', 'workitem.yaml', 'name: Q3\nsubtype: campaign\nstatus: idea\n')
    expect(addCriterion(project, 'campaigns/q3', 'it works').ok).toBe(true)
    expect(read('campaigns/q3', 'workitem.md')).toContain('## Acceptance Criteria\n\n- [ ] it works\n')
    yamlIsGone()
  })

  // reason: a bug is the conversion with the most translation in it — three
  // YAML strings become three headings, and `severity` is the one frontmatter
  // key no other level carries. A conversion runs once per file on somebody's
  // repository and can never be re-run, so a heading it dropped is gone.
  it('converts a legacy bug, with its severity and every section it carried', () => {
    legacyBoard()
    putLegacy(
      'campaigns/q3/bugs/crash',
      'bug.yaml',
      'name: Crash\nstatus: backlog\nseverity: critical\ndescription: it crashes on launch\n' +
        'steps_to_reproduce: open the app\nexpected: it opens\nactual: it dies\n' +
        'rca: a null map\nenvironment: macOS 15\n',
    )
    expect(updateEntity(project, 'campaigns/q3/bugs/crash', { notes: 'seen twice' }).ok).toBe(true)
    const text = read('campaigns/q3/bugs/crash', 'bug.md')
    expect(text).toContain('severity: critical')
    expect(text).toContain('status: backlog')
    expect(text).toContain('\nit crashes on launch\n')
    expect(text).toContain('## Steps to Reproduce\n\nopen the app\n')
    expect(text).toContain('## Expected\n\nit opens\n')
    expect(text).toContain('## Actual\n\nit dies\n')
    expect(text).toContain('## RCA\n\na null map\n')
    expect(text).toContain('## Environment\n\nmacOS 15\n')
    expect(text).toContain('## Notes\n\nseen twice\n')
    const back = readBoard(project).campaigns[0].children.find((child) => child.level === 'bug')
    expect(back?.fields.severity).toBe('critical')
    expect(back?.fields.stepsToReproduce).toBe('open the app')
    expect(back?.fields.rca).toBe('a null map')
    expect(has('campaigns/q3/bugs/crash', 'bug.md')).toBe(true)
    expect(has('campaigns/q3/bugs/crash', 'bug.yaml')).toBe(false)
  })

  // reason: a task is the level whose criteria the board gates on, and it is
  // the one level no legacy conversion covered — its `acceptance_criteria`
  // list has to survive being ticked on the way through.
  it('converts a legacy task, keeping the criteria it is gated on', () => {
    legacyBoard()
    putLegacy('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\nsubtype: mission\nstatus: executing\n')
    putLegacy(
      'campaigns/q3/missions/m1/tasks/t1',
      'workitem.yaml',
      'name: T1\nsubtype: task\nstatus: executing\ndescription: do the thing\n' +
        'acceptance_criteria:\n  - text: the first\n    done: false\n  - text: the second\n    done: false\n',
    )
    const task = 'campaigns/q3/missions/m1/tasks/t1'
    expect(tickCriterion(project, task, 1, true).ok).toBe(true)
    const text = read(task, 'workitem.md')
    expect(text).toContain('subtype: task')
    expect(text).toContain('## Acceptance Criteria\n\n- [ ] the first\n- [x] the second\n')
    expect(text).toContain('\ndo the thing\n')
    expect(has(task, 'workitem.yaml')).toBe(false)
    // The mission above it is untouched: a write converts the entity it wrote,
    // and nothing else.
    expect(has('campaigns/q3/missions/m1', 'workitem.yaml')).toBe(true)
    expect(has('campaigns/q3/missions/m1', 'workitem.md')).toBe(false)
    const back = readBoard(project).campaigns[0].children[0].children[0]
    expect(back.fields.acceptanceCriteria).toEqual([
      { text: 'the first', done: false },
      { text: 'the second', done: true },
    ])
  })

  it('converts a test through recordRun, the one write that opens its own file', () => {
    legacyBoard()
    expect(recordRun(project, 'tests/login', 'campaigns/q3', 'pass', 'a').ok).toBe(true)
    const text = read('tests/login', 'test.md')
    expect(text).toContain('## Steps\n\nopen the login page\n')
    expect(text).toContain('workitem: campaigns/q3')
    expect(has('tests/login', 'test.md')).toBe(true)
    expect(has('tests/login', 'test.yaml')).toBe(false)
  })

  // reason: this is the ordering, and it is the only thing standing between a
  // failed write and an entity with no file at all. Removing the `.yaml` first
  // would leave the folder empty when the markdown never lands.
  it('leaves the yaml alone when the markdown write fails', () => {
    legacyBoard()
    disk.writeThrows = true
    expect(() => setStatus(project, 'campaigns/q3', 'executing')).toThrow()
    expect(has('campaigns/q3', 'workitem.yaml')).toBe(true)
    expect(has('campaigns/q3', 'workitem.md')).toBe(false)
    disk.writeThrows = false
    expect(readBoard(project).campaigns[0].name).toBe('Q3')
  })

  // reason: both files present is a conversion someone stalled or a file
  // someone edited by hand — the reader already says the `.yaml` is ignored,
  // and a writer that deleted it would delete the thing that finding is about.
  it('leaves a yaml beside a markdown alone, since it was not opened from it', () => {
    createEntity(project, 'campaign', '', 'Q3')
    putLegacy('campaigns/q3', 'workitem.yaml', 'name: Q3 by hand\n')
    expect(setStatus(project, 'campaigns/q3', 'executing').ok).toBe(true)
    expect(has('campaigns/q3', 'workitem.yaml')).toBe(true)
    expect(read('campaigns/q3', 'workitem.md')).toContain('status: executing')
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

// reason: findings 1 and 2 of the branch review. Both are the same root — a
// section body is opaque by the format's own claim and was not opaque to
// `splitDoc` — and both only show up against a real file, written more than
// once, which is what every other test in this file stops short of.
describe('a body that holds markdown of its own', () => {
  it('leaves the file byte-identical from the second write on', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    const bug = 'campaigns/q3/bugs/crash'
    expect(updateEntity(project, bug, { stepsToReproduce: 'run it:\n```\nnpm start', expected: 'it opens' }).ok).toBe(true)
    const texts: string[] = []
    for (let i = 0; i < 4; i += 1) {
      expect(setStatus(project, bug, 'executing').ok).toBe(true)
      texts.push(read(bug, 'bug.md'))
    }
    // The measured growth was 183 → 241 → 299 → 357 bytes, a whole heading set
    // gained per write. Four writes of the same status, four identical files.
    expect(new Set(texts).size).toBe(1)
    expect(texts[0].match(/^## Expected$/gm)).toHaveLength(1)
    const back = readBoard(project).campaigns[0].children.find((child) => child.level === 'bug')
    expect(back?.fields.expected).toBe('it opens')
    expect(back?.fields.stepsToReproduce).toContain('npm start')
  })

  it('converts a legacy file whose prose holds a heading, without re-attributing it', () => {
    legacyBoard()
    putLegacy(
      'campaigns/q3/bugs/crash',
      'bug.yaml',
      'name: Crash\nstatus: backlog\nseverity: major\n' +
        'description: |\n  intro\n\n  ## Design\n  deep stuff\n' +
        'notes: |\n  ## Notes\n  inner\n' +
        'steps_to_reproduce: |\n  run it:\n\n      indented four\n',
    )
    expect(setStatus(project, 'campaigns/q3/bugs/crash', 'executing').ok).toBe(true)
    const text = read('campaigns/q3/bugs/crash', 'bug.md')
    expect(text.match(/^## Notes$/gm)).toHaveLength(1)
    const back = readBoard(project).campaigns[0]?.children.find((child) => child.level === 'bug')
    expect(back?.fields.notes).toBe('### Notes\ninner')
    expect(back?.fields.description).toBe('intro\n\n### Design\ndeep stuff')
    expect(back?.fields.stepsToReproduce).toBe('run it:\n\n    indented four')
    expect(back?.fields.extraSections).toBeUndefined()
    expect(has('campaigns/q3/bugs/crash', 'bug.yaml')).toBe(false)
  })
})

/**
 * A `.md` on disk with Windows line endings, written through a real
 * `setStatus`.
 *
 * The assertion is on the file's **bytes**, not only on the fields read back,
 * because that is where the damage showed: `readBoard` merely reported an empty
 * name, and the write that followed made it permanent by re-emitting the
 * frontmatter as prose inside the description — 206 bytes becoming 304, with
 * `validated_by` and `documents` gone as data.
 */
describe('a campaign whose file was saved with CRLF line endings', () => {
  const CRLF = [
    '---',
    'name: Q3 Campaign',
    'subtype: campaign',
    'status: executing',
    'documents: []',
    'validated_by:',
    '  - test: tests/login',
    '    result: pass',
    "    comment: ''",
    '---',
    '',
    'the description',
    '',
    '## Target',
    '',
    'ship it',
    '',
    '## Notes',
    '',
    'n',
    '',
  ].join('\r\n')

  beforeEach(() => {
    putLegacy('campaigns/q3', 'workitem.md', CRLF)
    putLegacy('tests/login', 'test.md', '---\nname: Login\n---\n')
  })

  it('is read with its name and its links intact', () => {
    const campaign = readBoard(project).campaigns[0]
    expect(campaign.fields.name).toBe('Q3 Campaign')
    expect(campaign.fields.validatedBy).toEqual([{ test: 'tests/login', result: 'pass', comment: '' }])
    expect(campaign.fields.target).toBe('ship it')
  })

  it('is written back as one document rather than as its own frontmatter twice', () => {
    expect(setStatus(project, 'campaigns/q3', 'done')).toEqual({ ok: true, folderPath: 'campaigns/q3' })
    const text = read('campaigns/q3', 'workitem.md')
    expect(text).not.toContain('\r')
    // Two `---` lines: the fence. Four would be the frontmatter written twice,
    // the second copy as prose.
    expect(text.match(/^---$/gm)).toHaveLength(2)
    expect(text).toContain('name: Q3 Campaign')
    expect(text).toContain('status: done')
    expect(text).toContain('- test: tests/login')
    expect(text.split('\n## Target\n')).toHaveLength(2)
  })

  it('stops changing after the write that converts its line endings', () => {
    setStatus(project, 'campaigns/q3', 'done')
    const once = read('campaigns/q3', 'workitem.md')
    setStatus(project, 'campaigns/q3', 'done')
    setStatus(project, 'campaigns/q3', 'done')
    expect(read('campaigns/q3', 'workitem.md')).toBe(once)
  })
})

/**
 * `##` followed by nothing but whitespace, in a file somebody edited by hand.
 * The heading pattern matched it and `joinDoc` wrote back a `## ` the pattern
 * does not match, so the block's prose was re-attributed to the next section on
 * the following read — the same silent re-attribution the format's demotion
 * rule exists to prevent.
 */
describe('a hand-edited file holding a heading with no text', () => {
  it('keeps the prose under it where it was written, across repeated writes', () => {
    putLegacy('campaigns/q3', 'workitem.md', '---\nname: Q3\nsubtype: campaign\nstatus: idea\n---\n\nlead\n\n##  \t\nkept prose\n\n## Notes\n\nn\n')
    setStatus(project, 'campaigns/q3', 'done')
    const once = read('campaigns/q3', 'workitem.md')
    const campaign = readBoard(project).campaigns[0]
    expect(campaign.fields.description).toBe('lead\n\n##  \t\nkept prose')
    expect(campaign.fields.notes).toBe('n')
    setStatus(project, 'campaigns/q3', 'done')
    expect(read('campaigns/q3', 'workitem.md')).toBe(once)
  })
})
