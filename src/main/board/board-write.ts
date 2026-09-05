import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import {
  boardRoot,
  fileFor,
  folderFor,
  legacyFileFor,
  realpathAsFarAsExists,
  resolveInBoard,
  TESTS_DIR,
  TRASH_DIR,
} from './board-paths'
import { collectTests, entitySource, findEntity, findTest, readBoard } from './board-read'
import {
  dumpEntity,
  ENTITY_STATUSES,
  LEVEL_SECTIONS,
  LINK_RESULTS,
  loadEntity,
  loadLegacyEntity,
  typeOf,
  yamlFailureReason,
  type EntityFields,
  type EntityLevel,
} from './entity-schema'
import { slugify, uniqueSlug } from './slug'

/** What one write reports back. */
export type WriteResult = { ok: true; folderPath: string } | { ok: false; reason: string }

/** Which level may hold which, so a parent of the wrong level is refused rather than nested. */
const PARENT_OF: Record<EntityLevel, readonly EntityLevel[]> = {
  campaign: [],
  mission: ['campaign'],
  task: ['mission'],
  // A bug is parented by exactly one of a campaign or a mission.
  bug: ['campaign', 'mission'],
  // A test's parent is a suite, which is a directory rather than an entity —
  // checked by path instead, since there is nothing to look up.
  test: [],
}

/** The directory a level's siblings share, under its parent. */
const SIBLING_DIR: Record<EntityLevel, string> = {
  campaign: 'campaigns',
  mission: 'missions',
  task: 'tasks',
  bug: 'bugs',
  test: TESTS_DIR,
}

/**
 * Whether a folder's entity was read from the `<type>.yaml` the board shipped
 * before, rather than from its `<type>.md`.
 *
 * Asked of `entitySource` rather than answered here, because that is the
 * reader's own precedence and the two must not be able to disagree: an unlink
 * is only safe when it removes the file the reader has already stopped reading
 * from, and a second copy of the rule is a second rule the day the first one
 * changes.
 * @param dir - the entity's directory.
 * @param level - the entity's level, which names both files.
 * @returns true when the legacy file is the one the board reads there.
 */
function openedFromLegacy(dir: string, level: EntityLevel): boolean {
  return entitySource(dir, level)?.legacy ?? false
}

/**
 * Read one entity's file, for a write that is about to rewrite it.
 *
 * Tests live in their own container, addressed by path rather than found by
 * `findEntity`'s campaigns-only walk — so every write here checks both trees,
 * the same way `linkTest` already has to when it validates a test argument.
 * @param project - the project's root directory.
 * @param folderPath - the entity's path within the board.
 * @returns the level, the fields, the resolved directory, and whether the
 *   fields came from a legacy file — or why not.
 */
function open(
  project: string,
  folderPath: string,
):
  | { ok: true; level: EntityLevel; fields: EntityFields; dir: string; legacy: boolean }
  | { ok: false; reason: string } {
  const dir = resolveInBoard(project, folderPath)
  if (dir === undefined) return { ok: false, reason: `${folderPath} is not inside this project's board.` }
  const board = readBoard(project)
  const entity = findEntity(board, folderPath) ?? findTest(board.tests, folderPath)
  if (entity === undefined) return { ok: false, reason: `${folderPath} is not on the board.` }
  return { ok: true, level: entity.level, fields: entity.fields, dir, legacy: openedFromLegacy(dir, entity.level) }
}

/**
 * Write an entity's file, whole, through the schema — and, for one opened from
 * the format that came before, retire the file it was opened from.
 *
 * Whole-file rather than a patch, because the schema owns the key order and
 * which keys a level emits — and because `dumpEntity` re-emits the unmodelled
 * keys it carried in, which a line-level patch could not.
 *
 * The conversion is a write, never a migration pass: an entity becomes a
 * markdown document the first time something writes to it, and a board nobody
 * writes to keeps reading exactly as it did. The unlink is strictly after the
 * atomic write has returned, so a write that throws leaves the `.yaml` as the
 * only file — which is still a whole, readable entity. On the reverse failure
 * — the `.md` written and the unlink refused — the `.yaml` stays and the
 * reader says in a finding that it is being ignored, which is true and is the
 * one outcome a person can act on.
 * @param dir - the entity's directory.
 * @param level - which `<type>.md` to write.
 * @param fields - the fields to write.
 * @param legacy - true when the entity was opened from `<type>.yaml`, which is
 *   then removed once the markdown is safely on disk.
 */
function save(dir: string, level: EntityLevel, fields: EntityFields, legacy: boolean): void {
  writeFileAtomic(join(dir, fileFor(level)), dumpEntity(level, fields))
  if (!legacy) return
  try {
    unlinkSync(join(dir, legacyFileFor(level)))
  } catch {
    // Left where it is on purpose. The entity is already converted; the stale
    // `.yaml` is a reported finding rather than a lost write, and throwing
    // here would report a write that in fact succeeded as a failure.
  }
}

/**
 * Create an entity under a parent.
 *
 * The slug comes from the name and is numbered if taken, never reused: two
 * entities with one name is ordinary, and a create that silently overwrote the
 * first would destroy whatever plan it carried.
 * @param project - the project's root directory.
 * @param level - what to create.
 * @param parentFolder - the parent's folder path; empty for a campaign or for
 *   a test at the tests root.
 * @param name - the display name, which the slug is derived from.
 * @returns the new folder path, or why nothing was created.
 */
export function createEntity(project: string, level: EntityLevel, parentFolder: string, name: string): WriteResult {
  if (name.trim() === '') return { ok: false, reason: `Name the ${level} first.` }
  const board = readBoard(project)
  let parts: string[]
  if (level === 'test') {
    // A suite is a directory and nothing else, so there is no entity to look
    // up — only a path to check. An empty parent means the tests root.
    const suite = parentFolder === '' ? TESTS_DIR : parentFolder
    const resolvedSuite = resolveInBoard(project, suite)
    if (resolvedSuite === undefined) {
      return { ok: false, reason: `${suite} is not inside this project's board.` }
    }
    const resolvedTestsRoot = resolveInBoard(project, TESTS_DIR)!
    if (resolvedSuite !== resolvedTestsRoot && !resolvedSuite.startsWith(resolvedTestsRoot + sep)) {
      return { ok: false, reason: `${parentFolder} is not inside the tests container.` }
    }
    // From the RESOLVED suite, not the caller's raw string: `./tests/auth` and
    // `tests/` are both legitimate spellings of a path this already checked,
    // and slicing the string itself invents a suite ("s") or an empty segment
    // for whichever spelling was not the exact one this code expected.
    parts = resolvedSuite === resolvedTestsRoot ? [] : resolvedSuite.slice(resolvedTestsRoot.length + 1).split(sep)
  } else if (level === 'campaign') {
    parts = []
  } else {
    if (resolveInBoard(project, parentFolder) === undefined) {
      return { ok: false, reason: `${parentFolder} is not inside this project's board.` }
    }
    const parent = findEntity(board, parentFolder)
    if (parent === undefined) return { ok: false, reason: `${parentFolder} is not on the board.` }
    if (!PARENT_OF[level].includes(parent.level)) {
      return { ok: false, reason: `a ${level} cannot go under a ${parent.level}.` }
    }
    // The odd segments, not a filter on the words: a campaign legitimately
    // slugged `missions` would otherwise be dropped from its children's paths.
    parts = parentFolder.split('/').filter((_, at) => at % 2 === 1)
  }
  const under =
    level === 'test'
      ? join(boardRoot(project), TESTS_DIR, ...parts)
      : level === 'campaign'
        ? join(boardRoot(project), 'campaigns')
        : join(resolveInBoard(project, parentFolder)!, SIBLING_DIR[level])
  let taken: Set<string>
  try {
    taken = new Set(
      readdirSync(under, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    )
  } catch {
    taken = new Set()
  }
  const slug = uniqueSlug(slugify(name), taken)
  const folderPath = folderFor(level, [...parts, slug])
  const dir = resolveInBoard(project, folderPath)
  if (dir === undefined) return { ok: false, reason: `${folderPath} is not inside this project's board.` }
  mkdirSync(dir, { recursive: true })
  // Never legacy: nothing was opened, so there is no `.yaml` here that this
  // create is entitled to remove.
  save(
    dir,
    level,
    {
      name,
      description: '',
      acceptanceCriteria: [],
      documents: [],
      validatedBy: [],
      runs: [],
      ...(level === 'test' ? {} : { status: 'idea' }),
    },
    false,
  )
  return { ok: true, folderPath }
}

/**
 * Change some of an entity's fields, leaving the rest as they are.
 * @param project - the project's root directory.
 * @param folderPath - the entity to change.
 * @param patch - the fields to replace.
 * @returns the folder path, or why nothing changed.
 */
export function updateEntity(project: string, folderPath: string, patch: Partial<EntityFields>): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  save(found.dir, found.level, { ...found.fields, ...patch }, found.legacy)
  return { ok: true, folderPath }
}

/**
 * Move an entity to a status.
 *
 * A status is a claim, and this is where the claim is made. Nothing else in
 * this module writes one — no parent is touched, no child is cascaded to.
 * @param project - the project's root directory.
 * @param folderPath - the entity to move.
 * @param status - one of the six the board knows.
 * @returns the folder path, or why nothing moved.
 */
export function setStatus(project: string, folderPath: string, status: string): WriteResult {
  if (!(ENTITY_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, reason: `"${status}" is not a status. Use one of: ${ENTITY_STATUSES.join(', ')}.` }
  }
  const found = open(project, folderPath)
  if (!found.ok) return found
  // A test is not work in flight; it is the instrument work is measured
  // with. Letting a status land on one would put it in a column it does not
  // belong in, so this is refused rather than silently written.
  if (found.level === 'test') return { ok: false, reason: `${folderPath} is a test, which has no status.` }
  return updateEntity(project, folderPath, { status })
}

/**
 * Why a level refuses an acceptance criterion, when it does.
 *
 * Driven by `LEVEL_SECTIONS` rather than a hard-coded list of levels, so a
 * level later added to the schema without an `## Acceptance Criteria` section
 * is caught here too, instead of silently reintroducing the write-that-lies
 * this guards against. Criteria are a section and not a frontmatter key — they
 * are a checklist a person ticks in the document — so `LEVEL_KEYS` is the
 * wrong table to ask: it names no level's criteria, and asking it refuses
 * every level, which is the same lie with the sign flipped.
 * @param level - the level asked to carry a criterion.
 * @returns why it cannot, or nothing when it can.
 */
function whyNoCriteria(level: EntityLevel): string | undefined {
  if (LEVEL_SECTIONS[level].includes('Acceptance Criteria')) return undefined
  if (level === 'test') return 'a test is proof that work was done, not a plan for doing it'
  if (level === 'bug') return 'a bug is a defect report, not a plan'
  return `a ${level} carries no acceptance criteria`
}

/**
 * Add an acceptance criterion, unticked.
 *
 * Unticked always: a criterion created as already met is one nobody checked.
 * Refused for a level whose document has no `## Acceptance Criteria` section
 * at all — a test or a bug — rather than written and silently dropped by
 * `dumpEntity`, which is a refusal turned into a false success.
 * @param project - the project's root directory.
 * @param folderPath - the entity to add it to.
 * @param text - what has to be true.
 * @returns the folder path, or why nothing was added.
 */
export function addCriterion(project: string, folderPath: string, text: string): WriteResult {
  if (text.trim() === '') return { ok: false, reason: 'A criterion with no text cannot be checked.' }
  const found = open(project, folderPath)
  if (!found.ok) return found
  const why = whyNoCriteria(found.level)
  if (why !== undefined) return { ok: false, reason: `${folderPath} is a ${found.level}: ${why}, so it has no acceptance criteria.` }
  const criteria = [...found.fields.acceptanceCriteria, { text: text.trim(), done: false }]
  save(found.dir, found.level, { ...found.fields, acceptanceCriteria: criteria }, found.legacy)
  return { ok: true, folderPath }
}

/**
 * Tick or untick one criterion by its position.
 *
 * By position because that is what a person reading the list sees, and the
 * list is short. A position that is not there is refused rather than ignored:
 * ticking nothing and reporting success is how a gate passes on work that was
 * never done.
 * @param project - the project's root directory.
 * @param folderPath - the entity holding it.
 * @param index - zero-based position in the list.
 * @param done - true to tick, false to clear.
 * @returns the folder path, or why nothing changed.
 */
export function tickCriterion(project: string, folderPath: string, index: number, done: boolean): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  const why = whyNoCriteria(found.level)
  if (why !== undefined) return { ok: false, reason: `${folderPath} is a ${found.level}: ${why}, so it has no acceptance criteria.` }
  const criteria = found.fields.acceptanceCriteria
  if (!Number.isInteger(index) || index < 0 || index >= criteria.length) {
    return { ok: false, reason: `${folderPath} has ${String(criteria.length)} criteria, so there is none at ${String(index)}.` }
  }
  const next = criteria.map((one, at) => (at === index ? { ...one, done } : one))
  save(found.dir, found.level, { ...found.fields, acceptanceCriteria: next }, found.legacy)
  return { ok: true, folderPath }
}

/**
 * Move an entity, and everything under it, to the board's trash.
 *
 * Never a removal. A board entity carries the plan and the acceptance criteria
 * for real work, and a delete recoverable only through git's reflog is one
 * nobody recovers. The trash keeps the folder's own path under it, so what was
 * deleted is legible without opening anything.
 *
 * A name already in the trash is numbered rather than replaced: trashing twice
 * is ordinary — two agents, one stale board — and the second must not destroy
 * what the first put there.
 * @param project - the project's root directory.
 * @param folderPath - the entity to trash.
 * @returns the folder path, or why nothing was moved.
 */
export function trashEntity(project: string, folderPath: string): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  const parent = folderPath.slice(0, folderPath.lastIndexOf('/'))
  const slug = folderPath.slice(folderPath.lastIndexOf('/') + 1)
  const trashRoot = join(boardRoot(project), TRASH_DIR)
  // resolveInBoard refuses the trash outright, so it never gets a chance to
  // catch this the way it catches every other destination — the boundary has
  // to be drawn here instead. lstat, never stat: a symlink must not be
  // followed even to ask what it points at, or the answer is already wrong.
  try {
    if (lstatSync(trashRoot).isSymbolicLink()) {
      return { ok: false, reason: `${TRASH_DIR} is a symlink, so nothing can be trashed through it.` }
    }
  } catch {
    // No .trash yet — mkdirSync below makes an ordinary directory.
  }
  const into = join(trashRoot, parent)
  // `into` reconstructs the entity's own folder path under `.trash`, so a
  // symlink planted anywhere along that reconstruction — not just at `.trash`
  // itself — walks mkdirSync/renameSync straight through it. The same walk
  // resolveInBoard uses for a not-yet-existing target catches it here too:
  // realpath as far as something exists, then require that to stay under the
  // realpathed board root.
  const realInto = realpathAsFarAsExists(into)
  const realBoard = realpathAsFarAsExists(boardRoot(project))
  if (realInto !== realBoard && !realInto.startsWith(realBoard + sep)) {
    return { ok: false, reason: `${parent} is not inside this project's board.` }
  }
  mkdirSync(into, { recursive: true })
  let taken: Set<string>
  try {
    taken = new Set(
      readdirSync(into, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    )
  } catch {
    taken = new Set()
  }
  renameSync(found.dir, join(into, uniqueSlug(slug, taken)))
  return { ok: true, folderPath }
}

/**
 * Say that a test proves a workitem, and what happened when it was run.
 *
 * The verdict lands on the workitem rather than on the test, because a
 * verdict is about a pairing: one test can pass for the mission it was
 * written for and fail for the one that reused it, and both are true at once.
 *
 * Linking the same test twice replaces the verdict rather than adding a
 * second — a re-run is ordinary, and two verdicts for one pairing would leave
 * no way to say which is current. The old entry's bug goes with it: it
 * described a failure that is no longer the answer.
 * @param project - the project's root directory.
 * @param folderPath - the workitem being proved.
 * @param test - the test's folder path.
 * @param result - one of `LINK_RESULTS`.
 * @param comment - why, in the reader's own words; may be empty.
 * @param bug - the defect a failure produced, when one was filed.
 * @returns the workitem's folder path, or why nothing was linked.
 */
export function linkTest(
  project: string,
  folderPath: string,
  test: string,
  result: string,
  comment: string,
  bug?: string,
): WriteResult {
  if (!(LINK_RESULTS as readonly string[]).includes(result)) {
    return { ok: false, reason: `"${result}" is not a result. Use one of: ${LINK_RESULTS.join(', ')}.` }
  }
  const found = open(project, folderPath)
  if (!found.ok) return found
  if (typeOf(found.level) !== 'workitem') {
    return { ok: false, reason: `a ${found.level} does not declare what proves it.` }
  }
  const board = readBoard(project)
  const tests = new Set<string>()
  collectTests(board.tests, tests)
  if (!tests.has(test)) return { ok: false, reason: `${test} is not a test on this board.` }
  const kept = found.fields.validatedBy.filter((link) => link.test !== test)
  const link = { test, result, comment, ...(bug === undefined || bug === '' ? {} : { bug }) }
  save(found.dir, found.level, { ...found.fields, validatedBy: [...kept, link] }, found.legacy)
  return { ok: true, folderPath }
}

/**
 * Stop claiming that a test proves a workitem.
 *
 * This is how a test is retired: validation *is* the link, so a test nothing
 * points at proves nothing, which is exactly what retired means. A test that
 * was never linked is refused rather than reported as removed — saying a
 * thing was unlinked when it never was is how a stale board looks tidy.
 * @param project - the project's root directory.
 * @param folderPath - the workitem to unlink from.
 * @param test - the test's folder path.
 * @returns the workitem's folder path, or why nothing changed.
 */
export function unlinkTest(project: string, folderPath: string, test: string): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  if (typeOf(found.level) !== 'workitem') {
    return { ok: false, reason: `a ${found.level} does not declare what proves it.` }
  }
  const kept = found.fields.validatedBy.filter((link) => link.test !== test)
  if (kept.length === found.fields.validatedBy.length) {
    return { ok: false, reason: `${folderPath} does not name ${test}.` }
  }
  save(found.dir, found.level, { ...found.fields, validatedBy: kept }, found.legacy)
  return { ok: true, folderPath }
}

/**
 * Append one execution to a test's own history.
 *
 * Deliberately does not touch the workitem's verdict. A verdict is a claim
 * with an author; a run is a thing that happened. Letting a run rewrite a
 * verdict would put a claim on the board that nobody made — and the two
 * disagreeing is exactly the signal that a verdict has gone stale.
 * @param project - the project's root directory.
 * @param testFolder - the test that ran.
 * @param workitem - the workitem it was run against.
 * @param result - one of `LINK_RESULTS`.
 * @param at - when it ran; now, in ISO 8601, when not given.
 * @returns the test's folder path, or why nothing was recorded.
 */
export function recordRun(project: string, testFolder: string, workitem: string, result: string, at?: string): WriteResult {
  if (!(LINK_RESULTS as readonly string[]).includes(result)) {
    return { ok: false, reason: `"${result}" is not a result. Use one of: ${LINK_RESULTS.join(', ')}.` }
  }
  const dir = resolveInBoard(project, testFolder)
  if (dir === undefined) return { ok: false, reason: `${testFolder} is not inside this project's board.` }
  // The same preference `readEntity` walks, from the same function, for the
  // same reason: this is the one write that does not go through `open`, and a
  // board nobody has converted holds only `test.yaml` — refusing it as "not a
  // test" would make the run history the one thing a legacy board could not
  // record. The file it names is also the file the reason names, so a person
  // sent to look at a parse failure is sent to the one that is there.
  const source = entitySource(dir, 'test')
  if (source === undefined) return { ok: false, reason: `${testFolder} is not a test.` }
  const { file, legacy } = source
  let text: string
  try {
    text = readFileSync(join(dir, file), 'utf8')
  } catch {
    return { ok: false, reason: `${testFolder} is not a test.` }
  }
  let fields: EntityFields
  try {
    fields = legacy ? loadLegacyEntity(text, 'test') : loadEntity(text)
  } catch (error) {
    // Reading never throws out of a tool handler: the agent gets a sentence
    // naming the file, the way `readEntity` reports the same failure to
    // `board_read` — not a YAMLException reaching the HTTP transport.
    return { ok: false, reason: `${file} could not be read: ${yamlFailureReason(error)}` }
  }
  const runs = [...fields.runs, { at: at ?? new Date().toISOString(), workitem, result }]
  save(dir, 'test', { ...fields, runs }, legacy)
  return { ok: true, folderPath: testFolder }
}
