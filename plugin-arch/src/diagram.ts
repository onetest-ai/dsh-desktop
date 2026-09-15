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
  if (typeof value !== 'string' || value === '') throw new DiagramParseError(`${where}: missing "${key}"`)
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
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DiagramParseError(`${where}: missing "${key}"`)
  return value
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
  const x = record['x']
  const y = record['y']
  return {
    id: requireString(record, 'id', where),
    name: requireString(record, 'name', where),
    type: requireString(record, 'type', where),
    icon: optionalString(record, 'icon', where),
    status: status as NodeStatus | undefined,
    description: optionalString(record, 'description', where),
    childDiagram: optionalString(record, 'childDiagram', where),
    parent: optionalString(record, 'parent', where),
    x: typeof x === 'number' ? x : undefined,
    y: typeof y === 'number' ? y : undefined,
    w: requireNumber(record, 'w', where),
    h: requireNumber(record, 'h', where),
    pinned: record['pinned'] === true,
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
  const waypoints = record['waypoints']
  return {
    id: requireString(record, 'id', where),
    from: requireString(record, 'from', where),
    to: requireString(record, 'to', where),
    label: optionalString(record, 'label', where),
    sublabel: optionalString(record, 'sublabel', where),
    direction: direction as EdgeDirection,
    sourceHandle: optionalString(record, 'sourceHandle', where),
    targetHandle: optionalString(record, 'targetHandle', where),
    waypoints: Array.isArray(waypoints) ? (waypoints as Array<[number, number]>) : undefined,
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
