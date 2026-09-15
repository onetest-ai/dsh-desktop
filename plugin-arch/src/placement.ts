import type { ArchNode, Diagram } from './diagram.ts'

/** Clear space left between boxes when placing. */
const GAP = 60

/** Where the first node of an empty diagram goes. */
const ORIGIN = { x: 0, y: 0 }

/** Step used when walking outward to find free space. */
const STEP = 40

/**
 * Whether two boxes overlap, counting the gap as part of each.
 * @param a - one node, with coordinates.
 * @param b - another node, with coordinates.
 * @returns true when they collide.
 */
function collides(a: Required<Pick<ArchNode, 'x' | 'y' | 'w' | 'h'>>, b: Required<Pick<ArchNode, 'x' | 'y' | 'w' | 'h'>>): boolean {
  return !(
    a.x + a.w + GAP <= b.x ||
    b.x + b.w + GAP <= a.x ||
    a.y + a.h + GAP <= b.y ||
    b.y + b.h + GAP <= a.y
  )
}

/**
 * The point a new node would ideally occupy: the average position of the
 * neighbours it connects to.
 *
 * This is the whole reason edits are batched into one call. A node created by
 * one tool call and connected by the next two has no neighbours at the moment
 * it is placed, so it lands wherever the fallback puts it and the edges are
 * then drawn to a box in a corner. Placement must see the finished graph.
 * @param node - the node being placed.
 * @param diagram - the diagram, with its edges already present.
 * @param settled - nodes that already have coordinates, by id.
 * @returns the preferred top-left, or undefined when it has no placed neighbours.
 */
function preferredSpot(
  node: ArchNode,
  diagram: Diagram,
  settled: Map<string, ArchNode>,
): { x: number; y: number } | undefined {
  const neighbours: ArchNode[] = []
  for (const edge of diagram.edges) {
    const otherId = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : undefined
    if (otherId === undefined) continue
    const other = settled.get(otherId)
    if (other !== undefined) neighbours.push(other)
  }
  if (neighbours.length === 0) return undefined
  let sumX = 0
  let sumY = 0
  for (const neighbour of neighbours) {
    sumX += (neighbour.x ?? 0) + neighbour.w / 2
    sumY += (neighbour.y ?? 0) + neighbour.h / 2
  }
  // Below the centre of mass, which reads as "downstream" on a diagram whose
  // flow runs top to bottom — the shape both reference diagrams use.
  return {
    x: sumX / neighbours.length - node.w / 2,
    y: sumY / neighbours.length - node.h / 2 + node.h + GAP,
  }
}

/**
 * Walk outward from a starting point until nothing collides.
 *
 * A spiral rather than a scan: it keeps a placed node near where it wanted to
 * be, which is the point of having a preferred spot at all.
 * @param node - the node being placed.
 * @param start - where it would like to be.
 * @param taken - every box already occupying space.
 * @returns a free top-left position.
 */
function findFreeSpot(
  node: ArchNode,
  start: { x: number; y: number },
  taken: ReadonlyArray<Required<Pick<ArchNode, 'x' | 'y' | 'w' | 'h'>>>,
): { x: number; y: number } {
  let ring = 0
  for (;;) {
    // Ring 0 is the preferred spot itself; each later ring is a square of
    // candidate offsets at increasing distance, visited in a fixed order so
    // the result is deterministic.
    const offsets: Array<[number, number]> = ring === 0 ? [[0, 0]] : []
    if (ring > 0) {
      const span = ring * STEP
      for (let i = -ring; i <= ring; i += 1) {
        offsets.push([i * STEP, -span], [i * STEP, span], [-span, i * STEP], [span, i * STEP])
      }
    }
    for (const [dx, dy] of offsets) {
      const candidate = { x: start.x + dx, y: start.y + dy, w: node.w, h: node.h }
      if (!taken.some((other) => collides(candidate, other))) return { x: candidate.x, y: candidate.y }
    }
    ring += 1
    // Nothing legitimate needs more than this; a diagram with thousands of
    // boxes would exhaust it, and stopping beats looping forever.
    if (ring > 500) return { x: start.x, y: start.y + ring * STEP }
  }
}

/**
 * Give coordinates to every node that lacks them, and to no other node.
 *
 * Positions are inferred; manual placement survives inference. Those hold
 * together only because this function reads `x`/`y` and never rewrites an
 * existing pair — pinned or not. A pinned node is additionally never moved by
 * the explicit auto-layout command, which is the other half of the contract
 * and lives in the designer.
 * @param diagram - the diagram, with edges already applied.
 * @returns a diagram in which every node has coordinates.
 */
export function placeNewNodes(diagram: Diagram): Diagram {
  const settled = new Map<string, ArchNode>()
  const taken: Array<Required<Pick<ArchNode, 'x' | 'y' | 'w' | 'h'>>> = []
  for (const node of diagram.nodes) {
    if (node.x !== undefined && node.y !== undefined) {
      settled.set(node.id, node)
      taken.push({ x: node.x, y: node.y, w: node.w, h: node.h })
    }
  }

  // Stable order, so the same input always produces the same output.
  const pending = diagram.nodes.filter((node) => node.x === undefined || node.y === undefined)
  const placed = new Map<string, ArchNode>()
  for (const node of pending) {
    const start = preferredSpot(node, diagram, settled) ?? ORIGIN
    const spot = findFreeSpot(node, start, taken)
    const withSpot: ArchNode = { ...node, x: spot.x, y: spot.y }
    placed.set(node.id, withSpot)
    settled.set(node.id, withSpot)
    taken.push({ x: spot.x, y: spot.y, w: node.w, h: node.h })
  }

  if (placed.size === 0) return diagram
  return { ...diagram, nodes: diagram.nodes.map((node) => placed.get(node.id) ?? node) }
}
