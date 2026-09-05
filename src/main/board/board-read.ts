import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardRoot, fileFor, hasBoard, TESTS_DIR, TRASH_DIR } from './board-paths'
import {
  ENTITY_STATUSES,
  ENTITY_LEVELS,
  LINK_RESULTS,
  loadEntity,
  typeOf,
  yamlFailureReason,
  type EntityFields,
  type EntityLevel,
} from './entity-schema'

/**
 * Collapse a file-derived value to one line.
 *
 * `Finding.says` is documented as one line, and most findings are built from
 * fixed words that can never break that. These few interpolate a raw field
 * straight from the file, and a value like `status: "one\ntwo"` would turn one
 * finding into two lines an agent reads as two findings.
 * @param v - the raw value, as read from the file.
 * @returns it, with all whitespace collapsed to single spaces and trimmed.
 */
function oneLine(v: string): string {
  return v.replace(/\s+/g, ' ').trim()
}

/** Every file name an entity might be stored under, so a folder holding the wrong one can be named. */
const ENTITY_FILES: readonly string[] = [...new Set(ENTITY_LEVELS.map(fileFor))]

/**
 * The entity file a folder holds, when it is not the one `level` expected.
 *
 * A folder with none of these is legitimately empty — a suite, or a child
 * directory nobody has filled in yet. One that holds a different type's file
 * is not empty; it is mislabeled, and that is worth a finding rather than the
 * silent vanishing an absent `fileFor(level)` alone would produce.
 * @param dir - the folder to look in.
 * @param expected - the file this folder's level would hold.
 * @returns the file actually found, or nothing when the folder holds none.
 */
function otherEntityFile(dir: string, expected: string): string | undefined {
  return ENTITY_FILES.find((candidate) => candidate !== expected && existsSync(join(dir, candidate)))
}

/** One entity, with the children its folder holds. */
export interface Entity {
  level: EntityLevel
  /** Its path within the board, which is also its identity. */
  folderPath: string
  slug: string
  name: string
  /** '' for a test, which has none. */
  status: string
  fields: EntityFields
  /** Missions and bugs under a campaign; tasks and bugs under a mission. */
  children: Entity[]
  /**
   * How many of this entity's own children are `done`.
   *
   * Computed on every read and never written anywhere. Showing "1 of 2" is
   * what lets a person decide; it must not decide for them. See the spec's
   * *Status is set, never inferred*.
   */
  progress: { done: number; total: number }
}

/** Something the board could not read, or read and did not like. */
export interface Finding {
  folderPath: string
  /** One line, naming what is wrong. Never a stack trace. */
  says: string
}

/**
 * A directory under `tests/` that groups other tests.
 *
 * A suite has a slug and nothing else — no file, no status, no description —
 * because grouping is all it does, and a type that existed only to hold other
 * things is a type whose file nobody would ever fill in.
 */
export interface Suite {
  /** Its path within the board; `tests` for the root. */
  path: string
  slug: string
  suites: Suite[]
  tests: Entity[]
}

/** The whole board, and what could not be read of it. */
export interface Board {
  /** False when the project has no `.dsh/tasks/` at all — a state, not a failure. */
  present: boolean
  campaigns: Entity[]
  /** The tests container. Always present, empty when there are none. */
  tests: Suite
  findings: Finding[]
}

/** Which directory holds each level's children, and what level those are. */
const CHILDREN: Partial<Record<EntityLevel, { dir: string; level: EntityLevel }[]>> = {
  campaign: [
    { dir: 'missions', level: 'mission' },
    { dir: 'bugs', level: 'bug' },
  ],
  mission: [
    { dir: 'tasks', level: 'task' },
    { dir: 'bugs', level: 'bug' },
  ],
}

/**
 * The subdirectories of one directory, sorted, or none when it cannot be read.
 *
 * Sorted so two reads of one board produce the same order — the board is drawn
 * from this, and a list that reordered between reads would move under the
 * cursor for no reason anyone could see.
 * @param dir - the directory to list.
 * @returns the child directory names, in order.
 */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== TRASH_DIR)
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Read one entity's folder, its file, and everything under it.
 *
 * Returns nothing for a folder with no entity file in it. Children are
 * folder-derived, so a directory is a candidate rather than a declaration —
 * and a candidate that holds no entity file is not an entity. Inventing an
 * empty one named after its slug would put a thing on the board that nobody
 * created.
 * @param root - the board root.
 * @param folderPath - this entity's path within it.
 * @param level - the level its folder says it is.
 * @param findings - collected, appended to.
 * @returns the entity, or nothing when the folder holds none.
 */
function readEntity(root: string, folderPath: string, level: EntityLevel, findings: Finding[]): Entity | undefined {
  const dir = join(root, folderPath)
  const file = fileFor(level)
  let text: string
  try {
    text = readFileSync(join(dir, file), 'utf8')
  } catch {
    // Empty is legitimate — a suite, or a child directory nobody has filled
    // in yet — but holding a different type's file is not empty, it is
    // mislabeled, and that is worth saying rather than letting the whole
    // subtree under it vanish with no word.
    const found = otherEntityFile(dir, file)
    if (found !== undefined) {
      // For a test specifically, this folder does not stop here: holding no
      // test.yaml is exactly what makes `readSuite` walk it as a suite next.
      // The finding has to say that, not that it "is a test" — a claim the
      // walk that follows does not honor.
      const says =
        level === 'test'
          ? `holds ${found}, not ${file} — read as a suite instead, since it holds no test.yaml.`
          : `holds ${found}, not ${file} — this folder is a ${level}.`
      findings.push({ folderPath, says })
    }
    return undefined
  }
  let fields: EntityFields
  try {
    fields = loadEntity(text)
  } catch (error) {
    // Reading never repairs: the file stays exactly as it is, and the board
    // says which one it could not read.
    findings.push({ folderPath, says: `${file} could not be read: ${yamlFailureReason(error)}` })
    return undefined
  }
  const slug = folderPath.slice(folderPath.lastIndexOf('/') + 1)
  // A test has no status: it is not work in flight, it is the instrument the
  // work is measured with. An empty string rather than a default, so nothing
  // downstream can mistake it for a position on the board.
  const status = level === 'test' ? '' : (fields.status ?? 'draft')
  if (level !== 'test' && !(ENTITY_STATUSES as readonly string[]).includes(status)) {
    findings.push({ folderPath, says: `status "${oneLine(status)}" is not one the board knows.` })
  }
  if (level === 'test' && fields.status !== undefined) {
    findings.push({ folderPath, says: `has a status field ("${oneLine(fields.status)}"), but a test has no status.` })
  }
  // The path decides, because the path is what this walk followed. The key is
  // what the file claims, and a claim that disagrees is worth saying out loud
  // rather than quietly overruling.
  if (typeOf(level) === 'workitem' && fields.subtype !== undefined && fields.subtype !== level) {
    findings.push({ folderPath, says: `subtype says "${oneLine(fields.subtype)}" but this sits at ${level}.` })
  }
  if (typeOf(level) !== 'workitem' && fields.subtype !== undefined) {
    findings.push({ folderPath, says: `has a subtype field ("${oneLine(fields.subtype)}"), which only a workitem uses.` })
  }
  if (level === 'task' && fields.acceptanceCriteria.length === 0) {
    findings.push({ folderPath, says: 'this task has no acceptance criterion, so nothing can gate it.' })
  }
  const children: Entity[] = []
  for (const under of CHILDREN[level] ?? []) {
    for (const name of subdirectories(join(dir, under.dir))) {
      const child = readEntity(root, `${folderPath}/${under.dir}/${name}`, under.level, findings)
      if (child !== undefined) children.push(child)
    }
  }
  return {
    level,
    folderPath,
    slug,
    name: fields.name === '' ? slug : fields.name,
    status,
    fields,
    children,
    progress: { done: children.filter((child) => child.status === 'done').length, total: children.length },
  }
}

/**
 * Read one directory under `tests/`, and everything below it.
 *
 * A directory holding a `test.yaml` is a test; one that does not is a suite,
 * and is walked. That rule is what makes a suite free: nothing declares one,
 * and a suite that stops holding tests stops existing without anybody
 * deleting a file.
 * @param root - the board root.
 * @param path - this directory's path within the board.
 * @param slug - its own name.
 * @param findings - collected, appended to.
 * @returns the suite, with its tests and sub-suites.
 */
function readSuite(root: string, path: string, slug: string, findings: Finding[]): Suite {
  const suite: Suite = { path, slug, suites: [], tests: [] }
  for (const name of subdirectories(join(root, path))) {
    const under = `${path}/${name}`
    const test = readEntity(root, under, 'test', findings)
    if (test !== undefined) {
      suite.tests.push(test)
      // Holds a test.yaml is a test, full stop — so subdirectories beside it
      // are not walked. That rule must not also make them disappear quietly:
      // a test is supposed to be a leaf, and one that is not deserves a word.
      if (subdirectories(join(root, under)).length > 0) {
        findings.push({ folderPath: under, says: 'holds test.yaml and subdirectories; a test is a leaf, so they are not walked.' })
      }
    } else suite.suites.push(readSuite(root, under, name, findings))
  }
  return suite
}

/**
 * Every test on the board, by folder path.
 *
 * Flattened once per read rather than searched per link: a workitem with ten
 * links would otherwise walk the whole tests tree ten times. Exported because
 * the writer needs the same answer before it records a verdict, and two
 * flatteners over one tree are two chances to disagree about what a test is.
 * @param suite - the suite to flatten.
 * @param into - the set to add to.
 */
export function collectTests(suite: Suite, into: Set<string>): void {
  for (const test of suite.tests) into.add(test.folderPath)
  for (const child of suite.suites) collectTests(child, into)
}

/**
 * Check every workitem's links against the tests that exist.
 *
 * Three ways a link goes wrong, and each is reported rather than repaired: it
 * names a test that is not there, its verdict is not one of the three, or it
 * failed and nobody filed the bug. The last is the one worth having — a
 * failure nobody wrote down should not read as fine.
 * @param entities - the campaigns, walked in full.
 * @param tests - every test's folder path.
 * @param findings - collected, appended to.
 */
function checkLinks(entities: Entity[], tests: Set<string>, findings: Finding[]): void {
  const stack = [...entities]
  while (stack.length > 0) {
    const entity = stack.pop()!
    stack.push(...entity.children)
    for (const link of entity.fields.validatedBy) {
      if (!tests.has(link.test)) {
        findings.push({ folderPath: entity.folderPath, says: `validated_by names ${link.test}, which is not on the board.` })
      }
      if (!(LINK_RESULTS as readonly string[]).includes(link.result)) {
        findings.push({ folderPath: entity.folderPath, says: `result "${link.result}" is not one of pass, fail, not_run.` })
      }
      if (link.result === 'fail' && (link.bug ?? '') === '') {
        findings.push({ folderPath: entity.folderPath, says: `${link.test} failed and no bug was filed against it.` })
      }
    }
  }
}

/**
 * Rebuild the whole board from disk.
 *
 * A full read every time, with no incremental invalidation and no cache. A
 * board is tens to low hundreds of small files, so the read is milliseconds —
 * and a rebuild cannot drift from disk, which is the property the whole design
 * is built to keep. If a board ever grows large enough for this to hurt, that
 * is a measurement to act on, not a prediction to design around.
 * @param project - the project's root directory.
 * @returns the campaigns, the tests, and what could not be read.
 */
export function readBoard(project: string): Board {
  if (!hasBoard(project)) {
    return { present: false, campaigns: [], tests: { path: TESTS_DIR, slug: TESTS_DIR, suites: [], tests: [] }, findings: [] }
  }
  const root = boardRoot(project)
  const findings: Finding[] = []
  const campaigns: Entity[] = []
  for (const name of subdirectories(join(root, 'campaigns'))) {
    const campaign = readEntity(root, `campaigns/${name}`, 'campaign', findings)
    if (campaign !== undefined) campaigns.push(campaign)
  }
  const tests = readSuite(root, TESTS_DIR, TESTS_DIR, findings)
  const known = new Set<string>()
  collectTests(tests, known)
  checkLinks(campaigns, known, findings)
  return { present: true, campaigns, tests, findings }
}

/**
 * One entity by its folder path.
 *
 * A walk rather than an index: the board is already in memory and small, and a
 * second structure keyed by path is a second thing that can disagree with the
 * first. Tests are not searched; they are addressed by path through the
 * board's tests container.
 * @param board - the board to search.
 * @param folderPath - the path to find.
 * @returns the entity, or nothing when the board has none there.
 */
export function findEntity(board: Board, folderPath: string): Entity | undefined {
  const stack = [...board.campaigns]
  while (stack.length > 0) {
    const entity = stack.pop()!
    if (entity.folderPath === folderPath) return entity
    stack.push(...entity.children)
  }
  return undefined
}

/**
 * One test by its folder path, walking the tests container.
 *
 * Kept apart from `findEntity` rather than folded into it: a workitem and a
 * test are addressed through two different trees, and `findEntity`'s
 * campaigns-only walk is correct on its own terms — other code depends on it
 * staying that way. A caller that needs either kind of entity calls both.
 * @param suite - the tests container, or a suite within it, to search.
 * @param folderPath - the path to find.
 * @returns the test, or nothing when the container has none there.
 */
export function findTest(suite: Suite, folderPath: string): Entity | undefined {
  for (const test of suite.tests) {
    if (test.folderPath === folderPath) return test
  }
  for (const child of suite.suites) {
    const found = findTest(child, folderPath)
    if (found !== undefined) return found
  }
  return undefined
}
