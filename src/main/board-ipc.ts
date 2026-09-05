import { watch, type FSWatcher } from 'node:fs'
import { boardRoot } from './board/board-paths'
import { readBoard, type Entity, type Suite } from './board/board-read'

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

/** Every link on the board, so a test's count is one pass rather than a walk per test. */
function allLinks(entities: Entity[]): { test: string; result: string }[] {
  const out: { test: string; result: string }[] = []
  const stack = [...entities]
  while (stack.length > 0) {
    const entity = stack.pop()!
    stack.push(...entity.children)
    for (const link of entity.fields.validatedBy) out.push({ test: link.test, result: link.result })
  }
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
 * Watch a project's board and say when it moved.
 *
 * Recursive over `.dsh/tasks/`, which is where every write lands — the
 * panel's own, the agent's through its tools, and a `git checkout`'s. Only the
 * first is observable directly, so the rest are watched for.
 *
 * A project with no board is watched for nothing rather than having one made:
 * the directory appears when something creates it, and the next focus reads it.
 * @param project - the open project's directory, or nothing when none is.
 * @param changed - called on every event; the caller debounces.
 * @returns a function that stops watching.
 */
export function watchBoard(project: string | undefined, changed: () => void): () => void {
  if (project === undefined) return () => {}
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(boardRoot(project), { recursive: true, persistent: false }, () => {
      changed()
    })
  } catch {
    // No board yet, or a filesystem that cannot watch recursively. Neither is
    // a failure: the views still re-read on focus and after their own writes.
    return () => {}
  }
  return () => {
    watcher?.close()
  }
}
