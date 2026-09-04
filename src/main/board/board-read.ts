import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardRoot, hasBoard, TRASH_DIR } from './board-paths'
import { ENTITY_STATUSES, loadEntity, type EntityFields, type EntityKind } from './entity-schema'

/** One entity, with the children its folder holds. */
export interface Entity {
  kind: EntityKind
  /** Its path within the board, which is also its identity. */
  folderPath: string
  slug: string
  name: string
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

/** The whole board, and what could not be read of it. */
export interface Board {
  /** False when the project has no `.dsh/tasks/` at all — a state, not a failure. */
  present: boolean
  campaigns: Entity[]
  findings: Finding[]
}

/** Which directory holds each kind's children, and what kind those are. */
const CHILDREN: Partial<Record<EntityKind, { dir: string; kind: EntityKind }[]>> = {
  campaign: [
    { dir: 'missions', kind: 'mission' },
    { dir: 'bugs', kind: 'bug' },
  ],
  mission: [
    { dir: 'tasks', kind: 'task' },
    { dir: 'bugs', kind: 'bug' },
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
 * Returns nothing for a folder with no `<kind>.yaml` in it. Children are
 * folder-derived, so a directory is a candidate rather than a declaration —
 * and a candidate that holds no entity file is not an entity. Inventing an
 * empty one named after its slug would put a thing on the board that nobody
 * created.
 * @param root - the board root.
 * @param folderPath - this entity's path within it.
 * @param kind - the kind its file must be.
 * @param findings - collected, appended to.
 * @returns the entity, or nothing when the folder holds none.
 */
function readEntity(root: string, folderPath: string, kind: EntityKind, findings: Finding[]): Entity | undefined {
  const dir = join(root, folderPath)
  let text: string
  try {
    text = readFileSync(join(dir, `${kind}.yaml`), 'utf8')
  } catch {
    return undefined
  }
  let fields: EntityFields
  try {
    fields = loadEntity(text)
  } catch (error) {
    // Reading never repairs: the file stays exactly as it is, and the board
    // says which one it could not read.
    findings.push({ folderPath, says: `${kind}.yaml could not be read: ${(error as Error).message}` })
    return undefined
  }
  const slug = folderPath.slice(folderPath.lastIndexOf('/') + 1)
  const status = fields.status ?? 'draft'
  if (!(ENTITY_STATUSES as readonly string[]).includes(status)) {
    findings.push({ folderPath, says: `status "${status}" is not one the board knows.` })
  }
  if (kind === 'task' && fields.acceptanceCriteria.length === 0) {
    findings.push({ folderPath, says: 'this task has no acceptance criterion, so nothing can gate it.' })
  }
  const children: Entity[] = []
  for (const under of CHILDREN[kind] ?? []) {
    for (const name of subdirectories(join(dir, under.dir))) {
      const child = readEntity(root, `${folderPath}/${under.dir}/${name}`, under.kind, findings)
      if (child !== undefined) children.push(child)
    }
  }
  return {
    kind,
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
 * Rebuild the whole board from disk.
 *
 * A full read every time, with no incremental invalidation and no cache. A
 * board is tens to low hundreds of small files, so the read is milliseconds —
 * and a rebuild cannot drift from disk, which is the property the whole design
 * is built to keep. If a board ever grows large enough for this to hurt, that
 * is a measurement to act on, not a prediction to design around.
 * @param project - the project's root directory.
 * @returns the campaigns and what could not be read.
 */
export function readBoard(project: string): Board {
  if (!hasBoard(project)) return { present: false, campaigns: [], findings: [] }
  const root = boardRoot(project)
  const findings: Finding[] = []
  const campaigns: Entity[] = []
  for (const name of subdirectories(join(root, 'campaigns'))) {
    const campaign = readEntity(root, `campaigns/${name}`, 'campaign', findings)
    if (campaign !== undefined) campaigns.push(campaign)
  }
  return { present: true, campaigns, findings }
}

/**
 * One entity by its folder path.
 *
 * A walk rather than an index: the board is already in memory and small, and a
 * second structure keyed by path is a second thing that can disagree with the
 * first.
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
