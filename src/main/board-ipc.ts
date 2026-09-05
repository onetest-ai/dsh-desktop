import { existsSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { boardRoot, fileFor, hasBoard, legacyFileFor } from './board/board-paths'
import { findTest, readBoard, type Entity, type Suite } from './board/board-read'
import { bodyFor, LEVEL_SECTIONS } from './board/entity-schema'

/** One entity, cut to what the two views draw. */
export interface EntityWire {
  level: string
  folderPath: string
  name: string
  /** Empty for a test, which has none. */
  status: string
  children: EntityWire[]
  progress: { done: number; total: number }
  criteria: { done: number; total: number }
  verdicts: { pass: number; total: number }
}

/** One test, and how much of what it validates passes. */
export interface TestWire {
  folderPath: string
  name: string
  /** The reverse of a workitem's chip: what this test proves, and how much holds. */
  validates: { pass: number; total: number }
}

/** A suite, its sub-suites, and the tests directly inside it. */
export interface SuiteWire {
  path: string
  slug: string
  suites: SuiteWire[]
  tests: TestWire[]
}

/** The whole board, as the views receive it. */
export interface BoardViewData {
  present: boolean
  campaigns: EntityWire[]
  tests: SuiteWire
  findings: { folderPath: string; says: string }[]
}

/** An empty tests container, for a project with no board. */
function noTests(): SuiteWire {
  return { path: 'tests', slug: 'tests', suites: [], tests: [] }
}

/**
 * Cut one entity down to what is drawn.
 *
 * Counts rather than the fields they were counted from: a whole `EntityFields`
 * would carry every criterion's prose and every link's comment across the
 * bridge on every redraw, and the views render none of it. The file is one
 * click away for anyone who wants the rest.
 * @param entity - the entity as the store read it.
 * @returns the entity as a view draws it.
 */
function wire(entity: Entity): EntityWire {
  const criteria = entity.fields.acceptanceCriteria
  const verdicts = entity.fields.validatedBy
  return {
    level: entity.level,
    folderPath: entity.folderPath,
    name: entity.name,
    status: entity.status,
    children: entity.children.map(wire),
    progress: entity.progress,
    criteria: { done: criteria.filter((one) => one.done).length, total: criteria.length },
    verdicts: { pass: verdicts.filter((one) => one.result === 'pass').length, total: verdicts.length },
  }
}

/**
 * Cut the tests container down, counting what each test proves.
 *
 * The count runs the other way from a workitem's: a workitem asks how many of
 * its own checks hold, a test asks how much of what it covers holds. That
 * direction exists nowhere else, which is why the tree shows it.
 * @param suite - the suite as the store read it.
 * @param links - every workitem's links, flattened once for the whole board.
 * @returns the suite as the tree draws it.
 */
function wireSuite(suite: Suite, links: { test: string; result: string }[]): SuiteWire {
  return {
    path: suite.path,
    slug: suite.slug,
    suites: suite.suites.map((child) => wireSuite(child, links)),
    tests: suite.tests.map((test) => {
      const mine = links.filter((link) => link.test === test.folderPath)
      return {
        folderPath: test.folderPath,
        name: test.name,
        validates: { pass: mine.filter((link) => link.result === 'pass').length, total: mine.length },
      }
    }),
  }
}

/** One `validated_by` entry, and the workitem that made it. */
interface BoardLink {
  test: string
  result: string
  /** Who points at that test. The reverse direction, which only the whole board knows. */
  from: { folderPath: string; name: string }
}

/**
 * Every link on the board, so a test's count is one pass rather than a walk per test.
 *
 * In reading order — a campaign, then everything under it — rather than in
 * whatever order a stack happens to pop, because a test's detail lists these
 * back to a person and a list that reordered itself between two reads of the
 * same board would be one nobody could scan twice.
 * @param entities - the campaigns, walked in full.
 * @returns every link, each carrying the workitem it was written on.
 */
function allLinks(entities: Entity[]): BoardLink[] {
  const out: BoardLink[] = []
  const walk = (entity: Entity): void => {
    const from = { folderPath: entity.folderPath, name: entity.name }
    for (const link of entity.fields.validatedBy) out.push({ test: link.test, result: link.result, from })
    for (const child of entity.children) walk(child)
  }
  for (const entity of entities) walk(entity)
  return out
}

/**
 * Read the open project's board, for both views.
 *
 * A full read every time, and never a cache: it is the store's own rule, the
 * read is milliseconds, and a cached board is a second thing that can disagree
 * with disk. Both views call this, so neither can be showing something the
 * other is not.
 * @param project - the open project's directory, or nothing when none is.
 * @returns the board, cut to what is drawn.
 */
export function boardFor(project: string | undefined): BoardViewData {
  if (project === undefined) return { present: false, campaigns: [], tests: noTests(), findings: [] }
  const board = readBoard(project)
  if (!board.present) return { present: false, campaigns: [], tests: noTests(), findings: board.findings }
  const links = allLinks(board.campaigns)
  return {
    present: true,
    campaigns: board.campaigns.map(wire),
    tests: wireSuite(board.tests, links),
    findings: board.findings,
  }
}

/**
 * One entity, with everything a detail draws — the only place fields cross the bridge.
 *
 * Deliberately fatter than `EntityWire`, and deliberately for one entity at a
 * time. The board's wire carries counts because it draws hundreds of cards on
 * every redraw and reads none of the prose; a detail is one entity a person
 * opened on purpose, and the prose is the whole reason they opened it.
 */
export interface EntityDetailWire {
  level: string
  folderPath: string
  name: string
  status: string
  /** The parent's folder path and name, for the line under the heading. Absent for a campaign and a test. */
  parent?: { folderPath: string; name: string }
  /** The lead paragraph. */
  description: string
  /**
   * `[{ heading, body }]` in the level's own order, blank ones included so the reader sees the shape.
   *
   * `stray` marks a section this level does not own — modelled elsewhere in the
   * schema, or modelled nowhere. It is drawn with a finding rather than dropped:
   * the file is the only place it can be fixed, and a surface that hid it left
   * the reader nothing to act on.
   */
  sections: { heading: string; body: string; stray?: boolean }[]
  criteria: { text: string; done: boolean }[]
  /** Children as rows: tasks, bugs and sub-missions. */
  children: { level: string; folderPath: string; name: string; status: string }[]
  /** What validates this workitem. `name` is the test's own name, resolved here. */
  links: { test: string; name: string; result: string; comment: string; bug?: string }[]
  /** For a test: which workitems point at it, and with what verdict. */
  validates: { folderPath: string; name: string; result: string }[]
  /** The file to hand the editor when Open file is pressed. */
  file: string
}

/**
 * The entity at one folder path, and the entity that owns it.
 *
 * A walk that remembers where it came from, rather than a second index keyed
 * by path: the parent is not on `Entity` — children are folder-derived and
 * nothing points back up — so the only place it exists is in the walk that
 * found the child.
 * @param entities - the entities to search, at one level.
 * @param folderPath - the path to find.
 * @param parent - what owns `entities`, or nothing at the top of the board.
 * @returns the entity and its parent, or nothing when none of them is it.
 */
function locate(
  entities: Entity[],
  folderPath: string,
  parent?: Entity,
): { entity: Entity; parent?: Entity } | undefined {
  for (const entity of entities) {
    if (entity.folderPath === folderPath) return { entity, parent }
    const found = locate(entity.children, folderPath, entity)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Every heading the schema models, in the order `dumpEntity` writes the unowned ones.
 *
 * The same derivation `entity-schema.ts` makes for its own `ALL_HEADINGS`, and
 * a copy on purpose rather than an import, because that constant is private to
 * the module that writes files and exporting it would make the detail view a
 * second caller of a table whose only job is to order a write. What is shared
 * is the source both derive from — `LEVEL_SECTIONS` — so the two cannot
 * disagree about which headings exist, only about nothing at all.
 */
const ALL_HEADINGS: readonly string[] = [...new Set(Object.values(LEVEL_SECTIONS).flat())]

/**
 * The sections the file holds, paired with what the fields hold under each.
 *
 * `LEVEL_SECTIONS` and `bodyFor` are the same pair `dumpEntity` writes a file
 * from, so the detail shows exactly the headings the file has — blank ones
 * included, because a heading with nothing under it is an invitation to fill
 * it in and one the detail dropped would be a field the reader never learns
 * exists. `Acceptance Criteria` stays in the list even though `criteria`
 * carries the same items parsed: the position is what tells the surface where
 * to put the checkboxes among the prose.
 *
 * Then, in `dumpEntity`'s own order, every section the file carries that this
 * level does not own — first the ones the schema models and the level does not
 * (a `## Target` on a task, a `## Steps` on a bug, which is exactly what a
 * legacy bug's `steps:` converts into), then the ones nobody modelled at all.
 * Both are marked `stray`, because the store spec says one sentence about both:
 * a key or a section a level does not own "is malformed rather than lost, and
 * shows up as a finding". The modelled half used to reach neither list — it
 * lands in a typed field, never in `extraSections` — so the file kept prose
 * that the one surface built to read it drew nowhere.
 * @param entity - the entity as the store read it.
 * @returns the sections, in the order the file writes them.
 */
function sectionsOf(entity: Entity): { heading: string; body: string; stray?: boolean }[] {
  const owned = LEVEL_SECTIONS[entity.level]
  const out: { heading: string; body: string; stray?: boolean }[] = owned.map((heading) => ({
    heading,
    body: bodyFor(entity.fields, heading),
  }))
  // A blank one is not carried, for the reason `dumpEntity` does not write it:
  // an unowned heading is not an invitation, so an empty one is a finding
  // about nothing.
  for (const heading of ALL_HEADINGS) {
    if (owned.includes(heading)) continue
    const body = bodyFor(entity.fields, heading)
    if (body.trim() !== '') out.push({ heading, body, stray: true })
  }
  for (const section of entity.fields.extraSections ?? []) {
    out.push({ heading: section.heading, body: section.body, stray: true })
  }
  return out
}

/**
 * The file an entity is actually stored in, for Open file.
 *
 * `fileFor` names the format the board writes, and that is the answer for
 * every entity anybody has touched since the conversion. A board nobody has
 * converted still reads, though — `readEntity` falls back to the `.yaml` —
 * and handing the editor a `.md` that is not there would make Open file do
 * nothing at all on exactly those entities.
 * @param project - the open project's directory.
 * @param entity - the entity as the store read it.
 * @returns the file name within the entity's folder.
 */
function fileOf(project: string, entity: Entity): string {
  const file = fileFor(entity.level)
  if (existsSync(join(boardRoot(project), entity.folderPath, file))) return file
  const legacy = legacyFileFor(entity.level)
  return existsSync(join(boardRoot(project), entity.folderPath, legacy)) ? legacy : file
}

/**
 * Read one entity's detail, for the panel's detail view.
 *
 * A full read every time, and never a cache — `boardFor`'s rule, for
 * `boardFor`'s reason, and here it buys one more thing: a detail and a card
 * are cut from the same walk of the same files, so they cannot disagree about
 * a name, a status or a verdict. Every link's test name is resolved out of
 * that same board rather than by opening the test's own file, which is the
 * same rule applied one level down.
 *
 * An unknown folder path answers nothing, rather than throwing or inventing an
 * empty entity: the path came from a renderer holding a board it read a moment
 * ago, and an entity an agent deleted in between is a fallback to the board,
 * not a failure. An empty shell would draw as a real entity with no name.
 * @param project - the open project's directory, or nothing when none is.
 * @param folderPath - the entity's path within the board.
 * @returns the entity as a detail draws it, or nothing when the board has none there.
 */
export function detailFor(project: string | undefined, folderPath: string): EntityDetailWire | undefined {
  if (project === undefined) return undefined
  const board = readBoard(project)
  if (!board.present) return undefined
  const found = locate(board.campaigns, folderPath)
  const entity = found?.entity ?? findTest(board.tests, folderPath)
  if (entity === undefined) return undefined
  const links = allLinks(board.campaigns)
  return {
    level: entity.level,
    folderPath: entity.folderPath,
    name: entity.name,
    status: entity.status,
    // A campaign has nothing above it and a test hangs off no workitem at
    // all, so neither gets a line naming something that is not there.
    ...(found?.parent === undefined
      ? {}
      : { parent: { folderPath: found.parent.folderPath, name: found.parent.name } }),
    description: entity.fields.description,
    sections: sectionsOf(entity),
    criteria: entity.fields.acceptanceCriteria.map((one) => ({ text: one.text, done: one.done })),
    children: entity.children.map((child) => ({
      level: child.level,
      folderPath: child.folderPath,
      name: child.name,
      status: child.status,
    })),
    links: entity.fields.validatedBy.map((link) => ({
      test: link.test,
      // A link naming a test that is not on the board is a finding, not a
      // repair — and the row still has to draw, so it falls back to the path
      // it named rather than to a blank the reader could not act on.
      name: findTest(board.tests, link.test)?.name ?? link.test,
      result: link.result,
      comment: link.comment,
      ...(link.bug === undefined ? {} : { bug: link.bug }),
    })),
    // The reverse direction, which exists nowhere in the test's own file
    // because the verdict lives on the link. Only the whole board knows it.
    validates:
      entity.level !== 'test'
        ? []
        : links
            .filter((link) => link.test === entity.folderPath)
            .map((link) => ({ folderPath: link.from.folderPath, name: link.from.name, result: link.result })),
    file: fileOf(project, entity),
  }
}

/**
 * The deepest directory that exists on the way down to the board.
 *
 * A rung of a ladder, not a guess: `.dsh/tasks/` is watched recursively when
 * it is there, because that is where every write lands. When it is not, the
 * next directory up is watched for it appearing — and never recursively, since
 * a project root holds `node_modules` and every build directory on the
 * machine, and a recursive watch over those would report a rebuild as a board
 * change thousands of times a second.
 * @param project - the open project's directory.
 * @returns where to watch, and whether that watch descends.
 */
function watchPoint(project: string): { where: string; recursive: boolean } {
  const board = boardRoot(project)
  if (hasBoard(project)) return { where: board, recursive: true }
  const dsh = dirname(board)
  if (existsSync(dsh)) return { where: dsh, recursive: false }
  return { where: project, recursive: false }
}

/**
 * Watch a project's board and say when it moved.
 *
 * Recursive over `.dsh/tasks/`, which is where every write lands — the
 * panel's own, the agent's through its tools, and a `git checkout`'s. Only the
 * first is observable directly, so the rest are watched for.
 *
 * A project with no board is watched from as far down as it goes, and the
 * watch walks down behind whatever creates the rest. Nothing here creates a
 * directory: the ladder waits, it does not build. Without it a project that
 * had no board when it was opened would never learn that one appeared, which
 * is the whole primary path — ask the agent to plan something, and watch it
 * show up. Once the board exists the recursive watch catches everything, so
 * the hole was exactly the first create.
 * @param project - the open project's directory, or nothing when none is.
 * @param changed - called on every event; the caller debounces.
 * @returns a function that stops watching.
 */
export function watchBoard(project: string | undefined, changed: () => void): () => void {
  if (project === undefined) return () => {}
  let watcher: FSWatcher | undefined
  let stopped = false
  const arm = (): void => {
    if (stopped) return
    watcher?.close()
    watcher = undefined
    const at = watchPoint(project)
    try {
      watcher = watch(at.where, { recursive: at.recursive, persistent: false }, () => {
        // A non-recursive watch is a rung: the event may well be the one that
        // created the directory below it, so the watch moves down before the
        // views are told. The board's own watch is never re-armed — closing
        // and reopening a recursive watcher for every file an agent writes
        // would cost more than everything it is watching for.
        if (!at.recursive) arm()
        changed()
      })
    } catch {
      // A directory that has gone between the look and the watch, or a
      // filesystem that cannot watch recursively. Neither is a failure: the
      // views still re-read on focus and after their own writes.
    }
  }
  arm()
  return () => {
    stopped = true
    watcher?.close()
    watcher = undefined
  }
}
