import { EDGE_DIRECTIONS, NODE_STATUSES, type ArchEdge, type ArchNode, type Diagram, type EdgeDirection, type NodeStatus } from './diagram.ts'
import { placeNewNodes } from './placement.ts'

/** Default box size for a node nobody has resized. */
const DEFAULT_SIZE = { w: 220, h: 110 }

/** A node to add. No coordinates: placement assigns them. */
export interface NewNode {
  id: string
  name: string
  type: string
  icon?: string
  status?: NodeStatus
  description?: string
  childDiagram?: string
  parent?: string
  w?: number
  h?: number
}

/** Fields to change on an existing node. Geometry is deliberately absent. */
export interface NodeUpdate {
  id: string
  name?: string
  type?: string
  icon?: string
  status?: NodeStatus
  description?: string
  childDiagram?: string
}

/** An edge to add. Its id is assigned here. */
export interface NewEdge {
  from: string
  to: string
  label?: string
  sublabel?: string
  direction?: EdgeDirection
}

/** Everything one `arch_edit` call may change. */
export interface EditOps {
  addNodes?: NewNode[]
  updateNodes?: NodeUpdate[]
  removeNodes?: string[]
  addEdges?: NewEdge[]
  removeEdges?: string[]
}

/** An edit that cannot be applied. The message names what and why. */
export class EditError extends Error {
  /** @param message - the specific problem. */
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

/**
 * Read one element of an ops array as an object, or throw naming its position.
 *
 * Elements arrive from a cast like everything else in `ops`, and an array of
 * the right name full of the wrong things used to pass straight through.
 * @param raw - the element.
 * @param where - `ops.addNodes[0]` and the like, for the message.
 * @returns the element as a record.
 * @throws EditError when it is not an object.
 */
function opRecord(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EditError(`${where} must be an object`)
  }
  return raw as Record<string, unknown>
}

/**
 * A required, non-empty string field of an op.
 * @param record - the op.
 * @param key - the field name.
 * @param where - the op's position, for the message.
 * @returns the value.
 * @throws EditError naming the op and the field.
 */
function opString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (value === undefined || value === null) throw new EditError(`${where}: missing "${key}"`)
  if (typeof value !== 'string') throw new EditError(`${where}: "${key}" must be a string`)
  if (value === '') throw new EditError(`${where}: "${key}" must not be empty`)
  return value
}

/**
 * An optional string field of an op, refused rather than coerced when present
 * and wrong — `name: 42` used to be written as a number and read back as a
 * type error in a file the caller was told had been saved.
 * @param record - the op.
 * @param key - the field name.
 * @param where - the op's position, for the message.
 * @returns the value, or undefined when absent.
 * @throws EditError naming the op and the field.
 */
function opOptionalString(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new EditError(`${where}: "${key}" must be a string`)
  if (value === '') throw new EditError(`${where}: "${key}" must not be empty`)
  return value
}

/**
 * An optional finite number field of an op.
 * @param record - the op.
 * @param key - the field name.
 * @param where - the op's position, for the message.
 * @returns the value, or undefined when absent.
 * @throws EditError naming the op and the field.
 */
function opOptionalNumber(record: Record<string, unknown>, key: string, where: string): number | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EditError(`${where}: "${key}" must be a finite number`)
  }
  return value
}

/**
 * An optional field whose value must come from a closed set.
 *
 * The tool schema already declares `status` and `direction` as enums, but a
 * schema is a hint to a model, not a gate: `status: "bogus"` reached the store
 * and the parser then refused the file. Nothing is written that the next read
 * would refuse, so the set is checked here too.
 * @param record - the op.
 * @param key - the field name.
 * @param allowed - the permitted values.
 * @param where - the op's position, for the message.
 * @returns the value, or undefined when absent.
 * @throws EditError naming the op, the field and the offending value.
 */
function opOptionalEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  where: string,
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new EditError(`${where}: unknown ${key} "${String(value)}" — expected one of ${[...allowed].join(', ')}`)
  }
  return value
}

/**
 * Validate one node addition.
 * @param raw - the element, straight from the payload.
 * @param index - its position in `addNodes`.
 * @returns the node addition, with every field typed as claimed.
 * @throws EditError naming the op and the field.
 */
function asNewNode(raw: unknown, index: number): NewNode {
  const where = `ops.addNodes[${String(index)}]`
  const record = opRecord(raw, where)
  return {
    id: opString(record, 'id', where),
    name: opString(record, 'name', where),
    type: opString(record, 'type', where),
    icon: opOptionalString(record, 'icon', where),
    status: opOptionalEnum(record, 'status', NODE_STATUSES, where) as NodeStatus | undefined,
    description: opOptionalString(record, 'description', where),
    childDiagram: opOptionalString(record, 'childDiagram', where),
    parent: opOptionalString(record, 'parent', where),
    w: opOptionalNumber(record, 'w', where),
    h: opOptionalNumber(record, 'h', where),
  }
}

/**
 * Validate one node update. Geometry stays absent by design.
 * @param raw - the element, straight from the payload.
 * @param index - its position in `updateNodes`.
 * @returns the update, with every field typed as claimed.
 * @throws EditError naming the op and the field.
 */
function asNodeUpdate(raw: unknown, index: number): NodeUpdate {
  const where = `ops.updateNodes[${String(index)}]`
  const record = opRecord(raw, where)
  return {
    id: opString(record, 'id', where),
    name: opOptionalString(record, 'name', where),
    type: opOptionalString(record, 'type', where),
    icon: opOptionalString(record, 'icon', where),
    status: opOptionalEnum(record, 'status', NODE_STATUSES, where) as NodeStatus | undefined,
    description: opOptionalString(record, 'description', where),
    childDiagram: opOptionalString(record, 'childDiagram', where),
  }
}

/**
 * Validate one edge addition. Its id is assigned here, never sent.
 * @param raw - the element, straight from the payload.
 * @param index - its position in `addEdges`.
 * @returns the edge addition, with every field typed as claimed.
 * @throws EditError naming the op and the field.
 */
function asNewEdge(raw: unknown, index: number): NewEdge {
  const where = `ops.addEdges[${String(index)}]`
  const record = opRecord(raw, where)
  return {
    from: opString(record, 'from', where),
    to: opString(record, 'to', where),
    label: opOptionalString(record, 'label', where),
    sublabel: opOptionalString(record, 'sublabel', where),
    direction: opOptionalEnum(record, 'direction', EDGE_DIRECTIONS, where) as EdgeDirection | undefined,
  }
}

/**
 * Validate one id in `removeNodes` / `removeEdges`.
 * @param raw - the element.
 * @param index - its position.
 * @param key - which array it came from, for the message.
 * @returns the id.
 * @throws EditError naming the op.
 */
function asRemovalId(raw: unknown, index: number, key: string): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new EditError(`ops.${key}[${String(index)}] must be a non-empty string id`)
  }
  return raw
}

/**
 * The next free edge id.
 *
 * Sequential rather than random so a diagram file read twice looks the same,
 * and so a human can refer to an edge out loud.
 * @param edges - the edges already present.
 * @returns an unused id.
 */
function nextEdgeId(edges: readonly ArchEdge[]): string {
  let highest = 0
  for (const edge of edges) {
    const match = /^e-(\d+)$/.exec(edge.id)
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]))
  }
  return `e-${String(highest + 1)}`
}

/**
 * Apply a batch of changes to a diagram.
 *
 * ONE call rather than one tool per operation, and the reason is placement: a
 * node created by one call and connected by the next has no neighbours at the
 * moment it is placed, so it lands nowhere useful and the edges are drawn to a
 * box in a corner. Splitting this into `addNode` and `addEdge` tools would
 * silently defeat incremental placement — do not do it.
 *
 * Order within the batch: removals, then additions, then updates, then
 * placement once over the finished graph. Removals first so one call can
 * replace a node with a new one under the same id — and when that happens the
 * replacement inherits the removed node's position, pin and size, because a
 * replacement is still not a permission to move a box the user placed.
 * @param diagram - the diagram to change.
 * @param ops - the changes.
 * @returns a new diagram; the input is untouched.
 * @throws EditError when an operation names something that does not exist, or
 *   would create a duplicate.
 */
export function applyEdit(diagram: Diagram, ops: EditOps): Diagram {
  // `ops` arrives from a cast, at both call sites. Without this, a wrong shape
  // does not fail — `('nonsense').addNodes` is undefined, every field falls back
  // to empty, and the call reports success having changed nothing. A caller told
  // "ok" for an edit that silently did not happen is worse off than one told its
  // request was malformed.
  if (typeof ops !== 'object' || ops === null || Array.isArray(ops)) {
    throw new EditError('ops must be an object')
  }
  for (const key of ['addNodes', 'updateNodes', 'removeNodes', 'addEdges', 'removeEdges'] as const) {
    const value = ops[key]
    if (value !== undefined && !Array.isArray(value)) {
      throw new EditError(`ops.${key} must be an array`)
    }
  }

  // Element validation, before anything is applied. The top-level shape check
  // above was not enough: `{ addNodes: [{ nonsense: 1 }] }` passed it, built a
  // node with no id, name or type, was serialized to disk and reported ok —
  // and every later read of that file failed. Naming the op and the field turns
  // that silent corruption into an actionable `bad-request`.
  const addNodes = (ops.addNodes ?? []).map((raw, index) => asNewNode(raw, index))
  const updateNodes = (ops.updateNodes ?? []).map((raw, index) => asNodeUpdate(raw, index))
  const addEdges = (ops.addEdges ?? []).map((raw, index) => asNewEdge(raw, index))
  const removeNodeIds = (ops.removeNodes ?? []).map((raw, index) => asRemovalId(raw, index, 'removeNodes'))
  const removeEdgeIds = (ops.removeEdges ?? []).map((raw, index) => asRemovalId(raw, index, 'removeEdges'))

  const removedNodes = new Set(removeNodeIds)
  for (const id of removedNodes) {
    if (!diagram.nodes.some((node) => node.id === id)) throw new EditError(`cannot remove unknown node "${id}"`)
  }
  const removedEdges = new Set(removeEdgeIds)
  for (const id of removedEdges) {
    if (!diagram.edges.some((edge) => edge.id === id)) throw new EditError(`cannot remove unknown edge "${id}"`)
  }

  // What each removed id was sitting at, kept for the replace-in-one-call case
  // below. Captured before the filter, because after it the node is gone.
  const removedGeometry = new Map<string, ArchNode>()
  for (const node of diagram.nodes) {
    if (removedNodes.has(node.id)) removedGeometry.set(node.id, node)
  }

  let nodes = diagram.nodes.filter((node) => !removedNodes.has(node.id))
  // An edge to a removed node is removed with it: leaving it would make the
  // file unreadable by its own schema.
  let edges = diagram.edges.filter(
    (edge) => !removedEdges.has(edge.id) && !removedNodes.has(edge.from) && !removedNodes.has(edge.to),
  )

  for (const fresh of addNodes) {
    if (nodes.some((node) => node.id === fresh.id)) throw new EditError(`node "${fresh.id}" already exists`)
    // Replacing a node in one call must not move it. Remove-then-add under the
    // same id is how an agent rewrites a box's semantics, and it used to return
    // the node at (0,0), unpinned and back to the default size — silently
    // undoing a placement the user had made by hand, which is the one thing
    // this tool promises never to do. Geometry and the pin therefore carry
    // forward from what was removed; everything the addition states about
    // MEANING still comes from the addition.
    const replaced = removedGeometry.get(fresh.id)
    const node: ArchNode = {
      id: fresh.id,
      name: fresh.name,
      type: fresh.type,
      icon: fresh.icon,
      status: fresh.status,
      description: fresh.description,
      childDiagram: fresh.childDiagram,
      parent: fresh.parent,
      x: replaced?.x,
      y: replaced?.y,
      w: fresh.w ?? replaced?.w ?? DEFAULT_SIZE.w,
      h: fresh.h ?? replaced?.h ?? DEFAULT_SIZE.h,
      pinned: replaced?.pinned ?? false,
    }
    nodes = [...nodes, node]
  }

  for (const update of updateNodes) {
    const index = nodes.findIndex((node) => node.id === update.id)
    if (index === -1) throw new EditError(`cannot update unknown node "${update.id}"`)
    const existing = nodes[index]
    if (existing === undefined) continue
    // Geometry is absent from NodeUpdate by design, so a spread cannot move a
    // node the user placed.
    nodes = nodes.map((node, at) =>
      at === index
        ? {
            ...existing,
            name: update.name ?? existing.name,
            type: update.type ?? existing.type,
            icon: update.icon ?? existing.icon,
            status: update.status ?? existing.status,
            description: update.description ?? existing.description,
            childDiagram: update.childDiagram ?? existing.childDiagram,
          }
        : node,
    )
  }

  const known = new Set(nodes.map((node) => node.id))
  for (const fresh of addEdges) {
    if (!known.has(fresh.from)) throw new EditError(`edge from unknown node "${fresh.from}"`)
    if (!known.has(fresh.to)) throw new EditError(`edge to unknown node "${fresh.to}"`)
    edges = [
      ...edges,
      {
        id: nextEdgeId(edges),
        from: fresh.from,
        to: fresh.to,
        label: fresh.label,
        sublabel: fresh.sublabel,
        direction: fresh.direction ?? 'outgoing',
      },
    ]
  }

  // Placement LAST, over the finished graph. See the note above.
  return placeNewNodes({ ...diagram, nodes, edges })
}
