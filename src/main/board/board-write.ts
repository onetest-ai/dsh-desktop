import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join, sep } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import { boardRoot, folderFor, realpathAsFarAsExists, resolveInBoard, TRASH_DIR } from './board-paths'
import { findEntity, readBoard } from './board-read'
import { dumpEntity, ENTITY_STATUSES, type EntityFields, type EntityKind } from './entity-schema'
import { slugify, uniqueSlug } from './slug'

/** What one write reports back. */
export type WriteResult = { ok: true; folderPath: string } | { ok: false; reason: string }

/** Which kind may hold which, so a parent of the wrong kind is refused rather than nested. */
const PARENT_OF: Record<EntityKind, EntityKind | undefined> = {
  campaign: undefined,
  mission: 'campaign',
  task: 'mission',
  // A bug is parented by exactly one of a campaign or a mission; checked below.
  bug: undefined,
}

/**
 * Read one entity's file, for a write that is about to rewrite it.
 * @param project - the project's root directory.
 * @param folderPath - the entity's path within the board.
 * @returns the kind, the fields, and the resolved directory — or why not.
 */
function open(
  project: string,
  folderPath: string,
): { ok: true; kind: EntityKind; fields: EntityFields; dir: string } | { ok: false; reason: string } {
  const dir = resolveInBoard(project, folderPath)
  if (dir === undefined) return { ok: false, reason: `${folderPath} is not inside this project's board.` }
  const entity = findEntity(readBoard(project), folderPath)
  if (entity === undefined) return { ok: false, reason: `${folderPath} is not on the board.` }
  return { ok: true, kind: entity.kind, fields: entity.fields, dir }
}

/**
 * Write an entity's file, whole, through the schema.
 *
 * Whole-file rather than a patch, because the schema owns the key order and
 * which keys a kind emits — and because `dumpEntity` re-emits the unmodelled
 * keys it carried in, which a line-level patch could not.
 * @param dir - the entity's directory.
 * @param kind - which `<kind>.yaml` to write.
 * @param fields - the fields to write.
 */
function save(dir: string, kind: EntityKind, fields: EntityFields): void {
  writeFileAtomic(join(dir, `${kind}.yaml`), dumpEntity(kind, fields))
}

/**
 * Create an entity under a parent.
 *
 * The slug comes from the name and is numbered if taken, never reused: two
 * entities with one name is ordinary, and a create that silently overwrote the
 * first would destroy whatever plan it carried.
 * @param project - the project's root directory.
 * @param kind - what to create.
 * @param parentFolder - the parent's folder path; empty for a campaign.
 * @param name - the display name, which the slug is derived from.
 * @returns the new folder path, or why nothing was created.
 */
export function createEntity(project: string, kind: EntityKind, parentFolder: string, name: string): WriteResult {
  if (name.trim() === '') return { ok: false, reason: `Name the ${kind} first.` }
  const board = readBoard(project)
  let parts: string[]
  if (kind === 'campaign') {
    parts = []
  } else {
    if (resolveInBoard(project, parentFolder) === undefined) {
      return { ok: false, reason: `${parentFolder} is not inside this project's board.` }
    }
    const parent = findEntity(board, parentFolder)
    if (parent === undefined) return { ok: false, reason: `${parentFolder} is not on the board.` }
    const wanted = kind === 'bug' ? ['campaign', 'mission'] : [PARENT_OF[kind]]
    if (!wanted.includes(parent.kind)) {
      return { ok: false, reason: `a ${kind} cannot go under a ${parent.kind}.` }
    }
    // The odd segments, not a filter on the words: a campaign legitimately
    // slugged `missions` would otherwise be dropped from its own children's
    // paths. The shape is fixed — campaigns/<c>[/missions/<m>] — so position
    // is what identifies a slug, never its spelling.
    parts = parentFolder.split('/').filter((_, at) => at % 2 === 1)
  }
  const siblingDir = kind === 'campaign' ? 'campaigns' : kind === 'mission' ? 'missions' : kind === 'task' ? 'tasks' : 'bugs'
  const under =
    kind === 'campaign' ? join(boardRoot(project), 'campaigns') : join(resolveInBoard(project, parentFolder)!, siblingDir)
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
  const folderPath = folderFor(kind, [...parts, slug])
  const dir = resolveInBoard(project, folderPath)
  if (dir === undefined) return { ok: false, reason: `${folderPath} is not inside this project's board.` }
  mkdirSync(dir, { recursive: true })
  save(dir, kind, { name, description: '', acceptanceCriteria: [], documents: [], status: 'draft' })
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
  save(found.dir, found.kind, { ...found.fields, ...patch })
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
  return updateEntity(project, folderPath, { status })
}

/**
 * Add an acceptance criterion, unticked.
 *
 * Unticked always: a criterion created as already met is one nobody checked.
 * @param project - the project's root directory.
 * @param folderPath - the entity to add it to.
 * @param text - what has to be true.
 * @returns the folder path, or why nothing was added.
 */
export function addCriterion(project: string, folderPath: string, text: string): WriteResult {
  if (text.trim() === '') return { ok: false, reason: 'A criterion with no text cannot be checked.' }
  const found = open(project, folderPath)
  if (!found.ok) return found
  const criteria = [...found.fields.acceptanceCriteria, { text: text.trim(), done: false }]
  save(found.dir, found.kind, { ...found.fields, acceptanceCriteria: criteria })
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
  const criteria = found.fields.acceptanceCriteria
  if (!Number.isInteger(index) || index < 0 || index >= criteria.length) {
    return { ok: false, reason: `${folderPath} has ${String(criteria.length)} criteria, so there is none at ${String(index)}.` }
  }
  const next = criteria.map((one, at) => (at === index ? { ...one, done } : one))
  save(found.dir, found.kind, { ...found.fields, acceptanceCriteria: next })
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
