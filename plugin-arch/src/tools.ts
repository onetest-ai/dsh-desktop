import { defineTool, type ObjectValueSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { applyEdit, type EditOps } from './edit.ts'
import { listIcons } from './icons.ts'
import { createDiagram, listDiagrams, readDiagram, writeDiagram } from './store.ts'
import type { ToolHost } from './context.ts'

/**
 * The slice of `exec` this file reads. Deliberately narrow and local rather
 * than the real `ToolRunContext`'s `agent: Agent` field: `Agent['session']`
 * is a concrete, unrelated `Session` type from `dsh-session` that shares no
 * declared properties with the loosely-documented `cwd`/`meta.cwd` fields the
 * reference plugin reads off it at runtime (`agent?.session?.meta?.cwd`,
 * `agent?.session?.cwd`) — so `session` is typed `unknown` here and cast where
 * read, rather than claiming a structural relationship the real type does not
 * have.
 */
interface ToolExec {
  agent?: { session?: unknown }
}

/**
 * The project this call acts on: the calling session's own directory.
 *
 * Deliberately NOT a parameter. An earlier version asked the model for a
 * `workspaceId`, which it had no way to discover — there is no tool that
 * lists them and the ids are opaque registry keys, so every call failed.
 * Deriving it from the session is also the tighter boundary: the tool acts on
 * the directory the user is working in, and a caller cannot point it
 * somewhere else.
 * @param exec - the tool execution context.
 * @returns the session's working directory.
 */
function sessionProject(exec: ToolExec): string {
  const session = exec.agent?.session as { meta?: { cwd?: string }; cwd?: string } | undefined
  const metaCwd = session?.meta?.cwd
  if (typeof metaCwd === 'string' && metaCwd.length > 0) return metaCwd
  const cwd = session?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

/**
 * Read a required string argument, or say which one is missing.
 *
 * `String(args['id'])` would turn an absent id into the literal `"undefined"`
 * and hand it to the store, which then reports `diagram "undefined" not found`
 * — pointing the caller at a naming problem when the real fault is a missing
 * argument. The consumer here is a model choosing its next action from this
 * text, so naming the actual fault is the difference between a retry that can
 * work and one that cannot.
 * @param args - the tool arguments.
 * @param key - the argument name.
 * @returns the string value, or undefined when absent or not a string.
 */
function requiredArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Drop `undefined` from a value before it leaves a tool.
 *
 * The tool registry snapshots each result through `snapshotJsonValue`, which
 * refuses anything that cannot round-trip — and `parseDiagram` deliberately
 * sets absent optional fields to an explicit `undefined` so callers can
 * distinguish "not set" from "not present". That is right for the parser and
 * fatal here: a diagram with no icon failed the tool with `tool "arch_read"
 * returned invalid output: value is not lossless JSON`. Serializing and
 * re-parsing drops those keys and nothing else.
 * @param value - the value a tool is about to return.
 * @returns the same value with undefined-valued keys removed.
 */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Run a tool body against the session's project, turning throws into messages.
 *
 * A tool that rejects gives the model a stack trace; a tool that returns
 * `{ error }` gives it something to act on.
 * @param exec - the tool execution context.
 * @param body - the work.
 * @returns the body's value, made JSON-safe, or an error object.
 */
async function withProject<T>(exec: ToolExec, body: (project: string) => T): Promise<T | { error: string }> {
  try {
    return jsonSafe(await body(sessionProject(exec)))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ── output schema fragments ────────────────────────────────────────────────
//
// The real registry validates every returned value against `output.schema`
// (dsh-tools/lib/index.js throws ToolOutputError on a mismatch), so these
// describe exactly what the store's types produce — not a simplified sketch
// of them.
//
// Broken out as functions rather than inlined at each of the three call sites
// that need a whole `Diagram` shape (`arch_read`, `arch_create`, `arch_edit`).
// Each returns its literal via `satisfies ObjectValueSchemaSpec` rather than
// an `: ObjectValueSchemaSpec` return-type ANNOTATION: `defineTool<const S,
// const O>` relies on TypeScript inferring the exact literal type of what is
// passed as `output.schema` (`type: 'object'` as the literal `"object"`,
// `required: true` as literal `true`) to compute `InferValue<O>` — the type
// `execute` and `render` see. An explicit `ObjectValueSchemaSpec` return type
// widens every leaf back to the general interface shape (`type: string`,
// `required?: true`), which collapses `InferValue` to `Record<string, never>`
// and breaks every caller. `satisfies` checks the same assignability without
// performing that widening.

/** `{ error: string }` — the shape `withProject` returns on failure. */
function errorSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { error: { type: 'string', required: true } },
  } satisfies ObjectValueSchemaSpec
}

/** One `ArchNode`, matching `diagram.ts` field for field. */
function nodeSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
      type: { type: 'string', required: true },
      icon: { type: 'string' },
      status: { type: 'string', enum: ['live', 'future', 'deprecated', 'removed'] },
      description: { type: 'string' },
      childDiagram: { type: 'string' },
      parent: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      w: { type: 'number', required: true },
      h: { type: 'number', required: true },
      pinned: { type: 'boolean', required: true },
    },
  } satisfies ObjectValueSchemaSpec
}

/** One `ArchEdge`, matching `diagram.ts` field for field. */
function edgeSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      from: { type: 'string', required: true },
      to: { type: 'string', required: true },
      label: { type: 'string' },
      sublabel: { type: 'string' },
      direction: { type: 'string', required: true, enum: ['outgoing', 'bidirectional', 'none'] },
      sourceHandle: { type: 'string' },
      targetHandle: { type: 'string' },
      waypoints: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    },
  } satisfies ObjectValueSchemaSpec
}

/** A whole `Diagram`: title, nodes, edges. */
function diagramSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', required: true },
      nodes: { type: 'array', required: true, items: nodeSchema() },
      edges: { type: 'array', required: true, items: edgeSchema() },
    },
  } satisfies ObjectValueSchemaSpec
}

/** One row of `listDiagrams`' index: id, title, a node index, or a read error. */
function diagramSummarySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      title: { type: 'string', required: true },
      nodes: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            type: { type: 'string', required: true },
          },
        },
      },
      error: { type: 'string' },
    },
  } satisfies ObjectValueSchemaSpec
}

/** One `IconEntry`. */
function iconEntrySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      slug: { type: 'string', required: true },
      mediaType: {
        type: 'string',
        required: true,
        enum: ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'],
      },
    },
  } satisfies ObjectValueSchemaSpec
}

/**
 * Escape a string for use inside a Mermaid quoted label.
 *
 * Mermaid's own escape for a double quote is `#quot;`, not a backslash.
 * @param text - the raw text.
 * @returns the text, safe to place inside `"…"` in a Mermaid label or edge.
 */
function mermaidEscape(text: string): string {
  return text.replace(/"/g, '#quot;')
}

/**
 * A diagram's own node id, sanitized into a Mermaid-safe node identifier.
 *
 * Mermaid ids do not accept dots or dashes unquoted; every character outside
 * `[A-Za-z0-9_]` becomes `_`. Collisions after sanitizing are accepted —
 * diagram ids are already unique, and the odds of two colliding after this
 * substitution are low enough not to complicate the id map over.
 * @param id - the diagram's own node id.
 * @returns a Mermaid-safe identifier.
 */
function mermaidNodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_')
}

/**
 * The slice of a diagram `renderMermaid` reads.
 *
 * Deliberately not `Diagram` from `diagram.ts`: `status` and `direction` are
 * closed enums there, and `defineTool`'s `InferValue` only recovers an enum's
 * literal union when the schema author wrote it with `as const` — this file's
 * schema fragments do not, since their literal `type`/`required` fields (not
 * their enums) are what `InferValue` actually needs. The render callback's
 * `value` is therefore typed with `status`/`direction` widened to `string`,
 * and a `Diagram`-typed parameter would reject it. This interface asks for
 * only the fields Mermaid rendering touches, all of them plain strings.
 */
interface MermaidDiagram {
  title: string
  nodes: ReadonlyArray<{ id: string; name: string; type: string }>
  edges: ReadonlyArray<{ from: string; to: string; label?: string; direction: string }>
}

/**
 * Render one diagram as Mermaid, the way the user actually sees what the
 * agent just did: there is no canvas until Plan 2, and a JSON file is not a
 * diagram, but many chat surfaces draw a Mermaid fence natively, and where
 * they do not it is still compact, readable, and pasteable into anything
 * that does.
 * @param diagram - the diagram to render.
 * @returns a summary line, and — when there is at least one node — a fenced
 *   Mermaid flowchart beneath it.
 */
function renderMermaid(diagram: MermaidDiagram): string {
  const summary = `${diagram.title} — ${String(diagram.nodes.length)} nodes, ${String(diagram.edges.length)} edges`
  if (diagram.nodes.length === 0) return `${summary}\n(no nodes yet)`

  const ids = new Map(diagram.nodes.map((node) => [node.id, mermaidNodeId(node.id)]))
  const lines = ['flowchart TD']
  for (const node of diagram.nodes) {
    const label = `${mermaidEscape(node.name)}<br/>[${mermaidEscape(node.type)}]`
    lines.push(`  ${ids.get(node.id) ?? mermaidNodeId(node.id)}["${label}"]`)
  }
  for (const edge of diagram.edges) {
    const from = ids.get(edge.from) ?? mermaidNodeId(edge.from)
    const to = ids.get(edge.to) ?? mermaidNodeId(edge.to)
    const arrow = edge.direction === 'bidirectional' ? '<-->' : edge.direction === 'none' ? '---' : '-->'
    const label = edge.label !== undefined ? `|"${mermaidEscape(edge.label)}"|` : ''
    lines.push(`  ${from} ${arrow}${label} ${to}`)
  }
  return `${summary}\n\n\`\`\`mermaid\n${lines.join('\n')}\n\`\`\``
}

/**
 * The five tools.
 *
 * NONE of them accepts coordinates, and none pins, unpins, or runs layout.
 * Placement is inferred and a human drag pins it; an agent assigning x/y would
 * produce layouts that are technically valid and visually worthless, and would
 * overwrite deliberate human placement.
 *
 * There is deliberately no `arch_screenshot` (or any other viewing tool) in
 * this plan. An earlier version had one, describing itself as a way to "see"
 * a rendered diagram — there is no renderer yet, only JSON files, so it could
 * only ever return a canned "never been opened" message. Told it could view
 * something and finding no view, the model went looking for one via browser
 * automation on the app's own UI and failed on `querySelector` errors — a
 * capability advertised that does not exist sent it somewhere useless. It
 * returns in Plan 2, once the canvas exists and there is genuinely something
 * to capture; `arch_list` and `arch_read`'s descriptions say plainly that
 * there is nothing to look at instead.
 *
 * `id`, `title` and `ops` are deliberately NOT declared `required: true` in
 * their parameter schema, even though every tool that has them needs them:
 * the real registry validates arguments against that schema before `execute`
 * ever runs, and a violation there is a thrown `ToolArgsError`, not a value
 * this plugin composes. Leaving them schema-optional and checking them in the
 * body (`requiredArg`) keeps the actionable `{ error: "missing id" }` message
 * a prior review round asked for, instead of a generic framework-level
 * rejection the model cannot act on as directly.
 *
 * No tool takes a `workspaceId` either, and that absence is not an oversight:
 * an earlier version asked the model for one, and there was no way for it to
 * supply a valid value (see `sessionProject`). `withProject` derives the
 * project from `exec` instead.
 * @returns the tool definitions, ready to register.
 */
export function archTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'arch_list',
      description:
        'Every architecture diagram in the project, each with an index of its nodes (id, name, type). ' +
        'Call this FIRST: it shows which diagram a thing belongs on and whether an id is already taken, ' +
        'so you neither read every file nor create a duplicate box under a new id. Diagrams are JSON files ' +
        'under .dsh/arch/ in the project; there is no viewer and nothing to look at on screen, so read them ' +
        'with these tools rather than trying to open or inspect anything in the UI.',
      parameters: {},
      output: {
        schema: { oneOf: [{ type: 'array', items: diagramSummarySchema() }, errorSchema()] },
        render: (_args, value) => {
          if (!Array.isArray(value)) return [{ type: 'text', text: value.error }]
          if (value.length === 0) return [{ type: 'text', text: 'No diagrams yet.' }]
          const lines = value.map(
            (diagram) =>
              `${diagram.id}: ${diagram.title} (${String(diagram.nodes.length)} nodes)` +
              (diagram.error !== undefined ? ` — unreadable: ${diagram.error}` : ''),
          )
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async (_args, exec) => withProject(exec, (project) => listDiagrams(project)),
    }),
    defineTool({
      name: 'arch_read',
      description:
        'One diagram in full, including its edges and each node’s current geometry. Returns the diagram as ' +
        'data; there is no rendered view of it.',
      parameters: { id: { type: 'string', description: 'The diagram id.' } },
      output: {
        schema: { oneOf: [diagramSchema(), errorSchema()] },
        render: (_args, value) =>
          'error' in value ? [{ type: 'text', text: value.error }] : [{ type: 'text', text: renderMermaid(value) }],
      },
      execute: async (args, exec) =>
        withProject(exec, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          return readDiagram(project, id)
        }),
    }),
    defineTool({
      name: 'arch_create',
      description: 'Create a new, empty diagram. Fails rather than overwriting one that exists.',
      parameters: {
        id: { type: 'string', description: 'A short slug, used as the file name.' },
        title: { type: 'string', description: 'The display title.' },
      },
      output: {
        schema: { oneOf: [diagramSchema(), errorSchema()] },
        render: (args, value) =>
          'error' in value
            ? [{ type: 'text', text: value.error }]
            : [{ type: 'text', text: `Created diagram "${String(args.id)}": ${value.title}` }],
      },
      execute: async (args, exec) =>
        withProject(exec, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          const title = requiredArg(args, 'title')
          if (title === undefined) return { error: 'missing title' }
          return createDiagram(project, id, title)
        }),
    }),
    defineTool({
      name: 'arch_edit',
      description:
        'Apply a batch of changes to one diagram in a single call: add, update and remove nodes and edges together. ' +
        'ALWAYS send a new node and its connections in the SAME call — new nodes are positioned next to the ' +
        'neighbours they connect to, so a node added without its edges is placed before anything is known about ' +
        'it and ends up in a corner. Node ids should be stable, human-meaningful slugs (paypal, not n-7), and the ' +
        'same real-world thing should reuse its id across diagrams.',
      parameters: {
        id: { type: 'string', description: 'The diagram id.' },
        // Deliberately `type: 'json'` (accept-anything) rather than a nested
        // object/array schema: `applyEdit` is the one place that validates
        // ops' shape (EditError, naming the exact op and field), and a
        // pin-invariant regression test drives malformed ops — a string, an
        // addNodes that is an object, a node missing id/name/type — through
        // this tool expecting `{ error }` back, not a thrown framework
        // ToolArgsError. Declaring the nested shape here would make the
        // registry's own pre-execute validation reject those before
        // `applyEdit` ever runs, duplicating its validation with a worse
        // (schema-violation-list) message and turning a returned error into a
        // thrown one. The structure is documented in prose instead so the
        // model still has something to go on.
        ops: {
          type: 'json',
          description:
            'The changes: { addNodes?, updateNodes?, removeNodes?, addEdges?, removeEdges? }. Applied as ' +
            'removals, then additions, then updates, then placement over the finished graph. ' +
            'addNodes: [{ id, name, type, icon?, status?, description?, childDiagram? }] — id/name/type required; ' +
            'no coordinates, placement assigns them. type is a free-form label shown under the name, e.g. ' +
            '"System", "Actor", "External system: QuickBooks" — any string is valid. icon is a slug from ' +
            'arch_icons, e.g. "okta" or "custom:aws/ec2". status is one of live/future/deprecated/removed. ' +
            'updateNodes: [{ id, name?, type?, icon?, status?, description?, childDiagram? }] — id required, only ' +
            'the fields sent change; geometry is deliberately absent, you cannot move a box this way. ' +
            'removeNodes/removeEdges: [id, …] — removing a node removes every edge touching it too. ' +
            'addEdges: [{ from, to, label?, sublabel?, direction? }] — label is prose, e.g. "Liz attaches PDF ' +
            'invoice to email"; sublabel is a grey qualifier, e.g. "Implied"; direction is one of ' +
            'outgoing/bidirectional/none.',
        },
      },
      output: {
        schema: { oneOf: [diagramSchema(), errorSchema()] },
        render: (_args, value) =>
          'error' in value
            ? [{ type: 'text', text: value.error }]
            : [{ type: 'text', text: `"${value.title}" — ${String(value.nodes.length)} nodes, ${String(value.edges.length)} edges` }],
      },
      execute: async (args, exec) =>
        withProject(exec, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          const next = applyEdit(readDiagram(project, id), (args['ops'] ?? {}) as EditOps)
          writeDiagram(project, id, next)
          return next
        }),
    }),
    defineTool({
      name: 'arch_icons',
      description:
        'Search the icons available to this project — the bundled set plus anything under .dsh/arch/icons/ ' +
        'and the folders named in .dsh/arch/config.json. Always pass a query: an icon pack can run to a ' +
        'thousand files. You cannot add icons; that is done by hand in the designer.',
      parameters: {
        query: { type: 'string', description: 'Case-insensitive substring of the slug.' },
      },
      output: {
        schema: { oneOf: [{ type: 'array', items: iconEntrySchema() }, errorSchema()] },
        render: (_args, value) => {
          if (!Array.isArray(value)) return [{ type: 'text', text: value.error }]
          if (value.length === 0) return [{ type: 'text', text: 'No icons match.' }]
          return [{ type: 'text', text: value.map((icon) => icon.slug).join(', ') }]
        },
      },
      execute: async (args, exec) =>
        withProject(exec, (project) => {
          const query = args['query']
          return listIcons(project, typeof query === 'string' ? query : undefined)
        }),
    }),
  ]
}

/**
 * Register every tool, disposing with the calling fiber.
 * @param ctx - a context carrying the tool registry.
 */
export function registerArchTools(ctx: { tools: ToolHost }): void {
  for (const tool of archTools()) ctx.tools.register(tool)
}
