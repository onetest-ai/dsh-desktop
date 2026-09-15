/** Soft lifecycle label. Affects rendering only; it gates nothing. */
export type NodeStatus = 'live' | 'future' | 'deprecated' | 'removed'

/**
 * Arrowhead geometry. Unlike a node's `type`, this IS a closed set: it maps to
 * marker shapes, so an unknown value has nothing to draw.
 */
export type EdgeDirection = 'outgoing' | 'bidirectional' | 'none'

const STATUSES: ReadonlySet<string> = new Set<NodeStatus>(['live', 'future', 'deprecated', 'removed'])
const DIRECTIONS: ReadonlySet<string> = new Set<EdgeDirection>(['outgoing', 'bidirectional', 'none'])

/** One box on a diagram. */
export interface ArchNode {
  id: string
  name: string
  /**
   * An OPEN string, rendered verbatim as the grey `[…]` sublabel: `Actor`,
   * `External system: QuickBooks`, anything. Deliberately not an enum — once
   * `component` were a known type, something would have to decide where it may
   * appear, and that decision is the C4 rulebook this tool exists without.
   */
  type: string
  icon?: string
  status?: NodeStatus
  description?: string
  /** Another diagram id. Its presence is what makes this node drillable. */
  childDiagram?: string
  /** Same-canvas grouping — React Flow's `parentId`. Not `childDiagram`. */
  parent?: string
  /** Absent until placement assigns one. Present in every stored diagram. */
  x?: number
  y?: number
  w: number
  h: number
  /**
   * Set by a human drag, and by nothing else. A pinned node is never moved by
   * any automatic process — see the placement module.
   */
  pinned: boolean
}

/** One connector between two nodes. */
export interface ArchEdge {
  id: string
  from: string
  to: string
  label?: string
  sublabel?: string
  direction: EdgeDirection
  /** Which of the twelve anchors the user chose. Never recomputed. */
  sourceHandle?: string
  targetHandle?: string
  /** User-dragged routing overrides. They beat any router. */
  waypoints?: Array<[number, number]>
}

/** One diagram: a complete, self-contained file. */
export interface Diagram {
  title: string
  nodes: ArchNode[]
  edges: ArchEdge[]
}

/** A diagram file that cannot be read. Carries what was wrong, for the banner. */
export class DiagramParseError extends Error {
  /** @param message - what specifically failed, named well enough to fix by hand. */
  constructor(message: string) {
    super(message)
    this.name = 'DiagramParseError'
  }
}

/**
 * Read one field, or throw naming it.
 * @param record - the object being read.
 * @param key - the field name.
 * @param where - a human description of the containing thing.
 * @returns the string value.
 */
function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (value === undefined || value === null) throw new DiagramParseError(`${where}: missing "${key}"`)
  if (typeof value !== 'string') throw new DiagramParseError(`${where}: "${key}" must be a string`)
  if (value === '') throw new DiagramParseError(`${where}: "${key}" must not be empty`)
  return value
}

/**
 * Read an optional field, refusing a wrong type rather than coercing it.
 * @param record - the object being read.
 * @param key - the field name.
 * @param where - a human description of the containing thing.
 * @returns the string value, or undefined when absent.
 */
function optionalString(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new DiagramParseError(`${where}: "${key}" must be a string`)
  return value
}

/**
 * Read a number, or throw naming it.
 * @param record - the object being read.
 * @param key - the field name.
 * @param where - a human description of the containing thing.
 * @returns the numeric value.
 */
function requireNumber(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key]
  if (value === undefined || value === null) throw new DiagramParseError(`${where}: missing "${key}"`)
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DiagramParseError(`${where}: "${key}" must be a finite number`)
  return value
}

/**
 * Read an optional boolean, refusing a wrong type rather than coercing it.
 *
 * Absent means false — a hand-written node that never mentions `pinned` is
 * simply not pinned. But a present-and-wrong value throws, because
 * `"pinned": "true"` is a typo that would otherwise silently UNPIN a node the
 * user placed, leaving the placement module free to move a box they believe is
 * locked. The pin invariant is the one promise this tool makes; it must not be
 * lost to a coercion.
 * @param record - the object being read.
 * @param key - the field name.
 * @param where - a human description of the containing thing.
 * @returns the boolean value; false when absent.
 */
function optionalBoolean(record: Record<string, unknown>, key: string, where: string): boolean {
  const value = record[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new DiagramParseError(`${where}: "${key}" must be true or false`)
  return value
}

/**
 * Read an optional number, refusing a wrong type rather than dropping it.
 *
 * Absent means "not placed yet", which placement fills in. A present but
 * non-numeric value is a corrupted coordinate, and silently dropping it reads
 * downstream as "not placed" — handing a node the user positioned to the
 * placement module to move. Fail instead, naming the field.
 * @param record - the object being read.
 * @param key - the field name.
 * @param where - a human description of the containing thing.
 * @returns the numeric value, or undefined when absent.
 */
function optionalNumber(record: Record<string, unknown>, key: string, where: string): number | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DiagramParseError(`${where}: "${key}" must be a finite number`)
  }
  return value
}

/**
 * Read optional edge waypoints, validating every element.
 *
 * `Array.isArray` alone admits `["a", 1, {}]` and hands it downstream typed as
 * coordinate pairs, where it fails far from the file that caused it and with
 * nothing to point at. The element check is what keeps the error next to the
 * mistake.
 * @param record - the object being read.
 * @param where - a human description of the containing edge.
 * @returns the waypoints, or undefined when absent.
 */
function optionalWaypoints(record: Record<string, unknown>, where: string): Array<[number, number]> | undefined {
  const value = record['waypoints']
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new DiagramParseError(`${where}: "waypoints" must be an array`)
  return value.map((point, index): [number, number] => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      typeof point[0] !== 'number' ||
      typeof point[1] !== 'number' ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      throw new DiagramParseError(`${where}: waypoint ${String(index)} must be a pair of finite numbers`)
    }
    return [point[0], point[1]]
  })
}

/**
 * Read one node.
 * @param raw - the node object from JSON.
 * @param index - its position, for the error message.
 * @returns the node.
 */
function parseNode(raw: unknown, index: number): ArchNode {
  if (typeof raw !== 'object' || raw === null) throw new DiagramParseError(`node ${String(index)}: not an object`)
  const record = raw as Record<string, unknown>
  const where = `node ${String(index)}`
  const status = optionalString(record, 'status', where)
  if (status !== undefined && !STATUSES.has(status)) throw new DiagramParseError(`${where}: unknown status "${status}"`)
  const x = optionalNumber(record, 'x', where)
  const y = optionalNumber(record, 'y', where)
  // Both or neither. A node carries a position or it does not; one coordinate
  // alone is not a position, and treating it as "unplaced" would silently
  // discard the half the user typed — the one thing placement must never do.
  if ((x === undefined) !== (y === undefined)) {
    throw new DiagramParseError(`${where}: "x" and "y" must be set together, or both omitted`)
  }
  return {
    id: requireString(record, 'id', where),
    name: requireString(record, 'name', where),
    type: requireString(record, 'type', where),
    icon: optionalString(record, 'icon', where),
    status: status as NodeStatus | undefined,
    description: optionalString(record, 'description', where),
    childDiagram: optionalString(record, 'childDiagram', where),
    parent: optionalString(record, 'parent', where),
    x,
    y,
    w: requireNumber(record, 'w', where),
    h: requireNumber(record, 'h', where),
    pinned: optionalBoolean(record, 'pinned', where),
  }
}

/**
 * Read one edge.
 * @param raw - the edge object from JSON.
 * @param index - its position, for the error message.
 * @returns the edge.
 */
function parseEdge(raw: unknown, index: number): ArchEdge {
  if (typeof raw !== 'object' || raw === null) throw new DiagramParseError(`edge ${String(index)}: not an object`)
  const record = raw as Record<string, unknown>
  const where = `edge ${String(index)}`
  const direction = requireString(record, 'direction', where)
  if (!DIRECTIONS.has(direction)) throw new DiagramParseError(`${where}: unknown direction "${direction}"`)
  return {
    id: requireString(record, 'id', where),
    from: requireString(record, 'from', where),
    to: requireString(record, 'to', where),
    label: optionalString(record, 'label', where),
    sublabel: optionalString(record, 'sublabel', where),
    direction: direction as EdgeDirection,
    sourceHandle: optionalString(record, 'sourceHandle', where),
    targetHandle: optionalString(record, 'targetHandle', where),
    waypoints: optionalWaypoints(record, where),
  }
}

/**
 * Validate an already-decoded value as a diagram.
 *
 * Split out from `parseDiagram` because a diagram reaches this module by two
 * routes — text read off disk, and an object handed in over RPC — and only the
 * first went through any checking. `serializeDiagram` reads `title`, `nodes`
 * and `edges` unguarded, so an object missing `title` used to serialize
 * cleanly and write a file that the next read refuses. One validator, both
 * doors.
 * @param raw - the decoded value.
 * @returns the diagram.
 * @throws DiagramParseError naming the first field that is wrong.
 */
export function assertDiagram(raw: unknown): Diagram {
  if (typeof raw !== 'object' || raw === null) throw new DiagramParseError('not an object')
  const record = raw as Record<string, unknown>
  const title = requireString(record, 'title', 'diagram')
  const nodes = record['nodes']
  const edges = record['edges']
  if (!Array.isArray(nodes)) throw new DiagramParseError('diagram: "nodes" must be an array')
  if (!Array.isArray(edges)) throw new DiagramParseError('diagram: "edges" must be an array')
  return {
    title,
    nodes: nodes.map((node, index) => parseNode(node, index)),
    edges: edges.map((edge, index) => parseEdge(edge, index)),
  }
}

/**
 * Read a diagram file.
 *
 * Every failure names the field and the node or edge index, because the fix is
 * a hand edit in the editor pane open beside the canvas — "invalid diagram"
 * would send the user hunting through their own file.
 * @param text - the file's contents.
 * @returns the diagram.
 * @throws DiagramParseError when the file cannot be read.
 */
export function parseDiagram(text: string): Diagram {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new DiagramParseError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return assertDiagram(raw)
}

/**
 * Drop undefined fields so they do not serialize as `null` and come back as a
 * present-but-empty value on the next parse.
 * @param value - an object with possibly-undefined fields.
 * @returns the same object without them.
 */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/**
 * Write a diagram file.
 *
 * Two spaces and a trailing newline, so a hand edit in the editor pane and a
 * write from the canvas produce the same bytes and git shows only real changes.
 * @param diagram - the diagram to write.
 * @returns the file's contents.
 */
export function serializeDiagram(diagram: Diagram): string {
  const shaped = {
    title: diagram.title,
    nodes: diagram.nodes.map((node) => compact(node)),
    edges: diagram.edges.map((edge) => compact(edge)),
  }
  return `${JSON.stringify(shaped, null, 2)}\n`
}
