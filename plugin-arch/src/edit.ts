import type { ArchEdge, ArchNode, Diagram, EdgeDirection, NodeStatus } from './diagram.ts'
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
 * replace a node with a new one under the same id.
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

  const removedNodes = new Set(ops.removeNodes ?? [])
  for (const id of removedNodes) {
    if (!diagram.nodes.some((node) => node.id === id)) throw new EditError(`cannot remove unknown node "${id}"`)
  }
  const removedEdges = new Set(ops.removeEdges ?? [])
  for (const id of removedEdges) {
    if (!diagram.edges.some((edge) => edge.id === id)) throw new EditError(`cannot remove unknown edge "${id}"`)
  }

  let nodes = diagram.nodes.filter((node) => !removedNodes.has(node.id))
  // An edge to a removed node is removed with it: leaving it would make the
  // file unreadable by its own schema.
  let edges = diagram.edges.filter(
    (edge) => !removedEdges.has(edge.id) && !removedNodes.has(edge.from) && !removedNodes.has(edge.to),
  )

  for (const fresh of ops.addNodes ?? []) {
    if (nodes.some((node) => node.id === fresh.id)) throw new EditError(`node "${fresh.id}" already exists`)
    const node: ArchNode = {
      id: fresh.id,
      name: fresh.name,
      type: fresh.type,
      icon: fresh.icon,
      status: fresh.status,
      description: fresh.description,
      childDiagram: fresh.childDiagram,
      parent: fresh.parent,
      x: undefined,
      y: undefined,
      w: fresh.w ?? DEFAULT_SIZE.w,
      h: fresh.h ?? DEFAULT_SIZE.h,
      pinned: false,
    }
    nodes = [...nodes, node]
  }

  for (const update of ops.updateNodes ?? []) {
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
  for (const fresh of ops.addEdges ?? []) {
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
