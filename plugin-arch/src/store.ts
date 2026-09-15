import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write.ts'
import { parseDiagram, serializeDiagram, type Diagram } from './diagram.ts'
import { archRoot, resolveInArch } from './paths.ts'

/** A store operation that cannot proceed. Distinct from a parse failure. */
export class StoreError extends Error {
  /** @param message - the specific problem, naming the diagram. */
  constructor(message: string) {
    super(message)
    this.name = 'StoreError'
  }
}

/**
 * One row of the diagram index.
 *
 * It carries the nodes, not just the title, so a caller can find where
 * something belongs and whether an id is already taken WITHOUT reading every
 * file. Returning titles alone forced a read fan-out and left callers blind to
 * ids already in use, which is how duplicate boxes get created.
 */
export interface DiagramSummary {
  id: string
  title: string
  nodes: Array<{ id: string; name: string; type: string }>
  /** Present instead of real content when this one file could not be read. */
  error?: string
}

/**
 * A diagram id is a flat filename stem, and this is where that is enforced.
 *
 * The path fence refuses an escape, but it has no opinion about ids that are
 * merely wrong: `""` becomes the file `.json`, `"."` becomes `..json`, and
 * `"a/b"` writes a nested file that `listDiagrams`' non-recursive read will
 * never show — so a diagram could be created, read back by id, and still be
 * absent from the index. Requiring a plain stem closes all of those at once,
 * and the message tells the caller what to send instead.
 */
const DIAGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Resolve a diagram file that is expected to exist.
 *
 * Fence only, deliberately no stem rule. `listDiagrams` re-derives paths from
 * names it read off disk, and `readDiagram`/`deleteDiagram` address files a
 * user may have hand-made — applying the creation-time rule here would make
 * any non-conforming file permanently unreadable AND undeletable, with an
 * error that names the id rather than the recoverable state. You must always
 * be able to clean up what is already there.
 * @param project - the workspace root.
 * @param id - the diagram id.
 * @returns the absolute path.
 * @throws StoreError when the id escapes the arch directory.
 */
function fileForExisting(project: string, id: string): string {
  const resolved = resolveInArch(project, `${id}.json`)
  if (resolved === undefined) throw new StoreError(`refused diagram id "${id}"`)
  return resolved
}

/**
 * Resolve a diagram file this call is about to create or overwrite.
 *
 * The stem rule belongs here and only here: it stops a caller MAKING a name
 * that cannot be listed. `"a/b"` would write `.dsh/arch/a/b.json`, readable by
 * id but invisible to `listDiagrams`' non-recursive read — a diagram that
 * exists and reports that it does not.
 *
 * The fence still runs after it. The regex rejects the traversal shapes a
 * caller can spell, but only the fence catches a symlink escape on an
 * otherwise well-formed id, so it remains the security boundary.
 * @param project - the workspace root.
 * @param id - the diagram id.
 * @returns the absolute path.
 * @throws StoreError when the id is malformed or escapes the arch directory.
 */
function fileForNew(project: string, id: string): string {
  if (!DIAGRAM_ID.test(id)) {
    throw new StoreError(
      `refused diagram id "${id}": use letters, digits, dots, dashes or underscores, starting with a letter or digit`,
    )
  }
  return fileForExisting(project, id)
}

/**
 * Every diagram in a project, with its node index.
 *
 * A project with no arch directory lists nothing rather than creating one:
 * looking at a repository must not write to it.
 * @param project - the workspace root.
 * @returns one row per diagram, sorted by id.
 */
export function listDiagrams(project: string): DiagramSummary[] {
  const root = archRoot(project)
  let names: string[]
  try {
    if (!statSync(root).isDirectory()) return []
    names = readdirSync(root)
  } catch {
    return []
  }
  const summaries: DiagramSummary[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    try {
      const diagram = parseDiagram(readFileSync(fileForExisting(project, id), 'utf8'))
      summaries.push({
        id,
        title: diagram.title,
        nodes: diagram.nodes.map((node) => ({ id: node.id, name: node.name, type: node.type })),
      })
    } catch (error) {
      // One unreadable file must not take out the index. The row carries the
      // reason so the caller can show which file needs a hand edit.
      summaries.push({ id, title: id, nodes: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return summaries
}

/**
 * Read one diagram.
 * @param project - the workspace root.
 * @param id - the diagram id.
 * @returns the diagram.
 * @throws StoreError when it does not exist, or the id is refused; the parse
 *   error, with the file named, when it cannot be read.
 */
export function readDiagram(project: string, id: string): Diagram {
  const file = fileForExisting(project, id)
  if (!existsSync(file)) throw new StoreError(`diagram "${id}" not found`)
  try {
    return parseDiagram(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new StoreError(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Write one diagram, whole.
 * @param project - the workspace root.
 * @param id - the diagram id.
 * @param diagram - what to write.
 */
export function writeDiagram(project: string, id: string, diagram: Diagram): void {
  writeFileAtomic(fileForNew(project, id), serializeDiagram(diagram))
}

/**
 * Create a diagram, refusing to clobber one that exists.
 *
 * This is the only path that brings `.dsh/arch/` into being — a deliberate
 * create, never a side effect of reading.
 * @param project - the workspace root.
 * @param id - the diagram id.
 * @param title - its display title.
 * @returns the new, empty diagram.
 * @throws StoreError when the id is refused or already taken.
 */
export function createDiagram(project: string, id: string, title: string): Diagram {
  const file = fileForNew(project, id)
  if (existsSync(file)) throw new StoreError(`diagram "${id}" already exists`)
  const diagram: Diagram = { title, nodes: [], edges: [] }
  writeFileAtomic(file, serializeDiagram(diagram))
  return diagram
}

/**
 * Remove a diagram.
 * @param project - the workspace root.
 * @param id - the diagram id.
 * @throws StoreError when it does not exist.
 */
export function deleteDiagram(project: string, id: string): void {
  const file = fileForExisting(project, id)
  if (!existsSync(file)) throw new StoreError(`diagram "${id}" not found`)
  rmSync(file)
}
