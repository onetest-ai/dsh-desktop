import { defineTool, type ObjectValueSchemaSpec, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { applyEdit, type EditOps } from './edit.ts'
import { listIcons } from './icons.ts'
import type { WorkspaceLookup } from './rpc.ts'
import { createDiagram, listDiagrams, readDiagram, writeDiagram } from './store.ts'
import type { ToolHost } from './context.ts'

/** Every tool takes the workspace; the project path is never a parameter. */
const WORKSPACE_PARAM = {
  workspaceId: { type: 'string', description: 'The workspace whose diagrams to act on.' },
} satisfies ParameterSchemaSpec

/**
 * Read the workspace path, or explain why not.
 * @param workspaces - the registry.
 * @param args - the tool arguments.
 * @returns the project path, or an error message.
 */
function projectOf(workspaces: WorkspaceLookup, args: Record<string, unknown>): { path: string } | { error: string } {
  const id = args['workspaceId']
  if (typeof id !== 'string') return { error: 'missing workspaceId' }
  const workspace = workspaces.get(id)
  if (workspace === undefined) return { error: `unknown workspace "${id}"` }
  return { path: workspace.path }
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
 * Run a tool body against a resolved project, turning throws into messages.
 *
 * A tool that rejects gives the model a stack trace; a tool that returns
 * `{ error }` gives it something to act on.
 * @param workspaces - the registry.
 * @param args - the tool arguments.
 * @param body - the work.
 * @returns the body's value, or an error object.
 */
async function withProject<T>(
  workspaces: WorkspaceLookup,
  args: Record<string, unknown>,
  body: (project: string) => T,
): Promise<T | { error: string }> {
  const resolved = projectOf(workspaces, args)
  if ('error' in resolved) return resolved
  try {
    return await body(resolved.path)
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
 * The six tools.
 *
 * NONE of them accepts coordinates, and none pins, unpins, or runs layout.
 * Placement is inferred and a human drag pins it; an agent assigning x/y would
 * produce layouts that are technically valid and visually worthless, and would
 * overwrite deliberate human placement. `arch_screenshot` is how the agent
 * CHECKS a layout — it looks and reports, rather than rearranging.
 *
 * `workspaceId`, `id`, `title` and `ops` are deliberately NOT declared
 * `required: true` in their parameter schema, even though every tool needs
 * them: the real registry validates arguments against that schema before
 * `execute` ever runs, and a violation there is a thrown `ToolArgsError`, not
 * a value this plugin composes. Leaving them schema-optional and checking
 * them in the body (`projectOf`, `requiredArg`) keeps the actionable
 * `{ error: "missing id" }` message a prior review round asked for, instead
 * of a generic framework-level rejection the model cannot act on as directly.
 * @param workspaces - the workspace registry, narrowed.
 * @returns the tool definitions, ready to register.
 */
export function archTools(workspaces: WorkspaceLookup): ToolDefinition[] {
  return [
    defineTool({
      name: 'arch_list',
      description:
        'Every architecture diagram in the project, each with an index of its nodes (id, name, type). ' +
        'Call this FIRST: it shows which diagram a thing belongs on and whether an id is already taken, ' +
        'so you neither read every file nor create a duplicate box under a new id.',
      parameters: { ...WORKSPACE_PARAM },
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
      execute: async (args) => withProject(workspaces, args, (project) => listDiagrams(project)),
    }),
    defineTool({
      name: 'arch_read',
      description: 'One diagram in full, including its edges and each node’s current geometry.',
      parameters: { ...WORKSPACE_PARAM, id: { type: 'string', description: 'The diagram id.' } },
      output: {
        schema: { oneOf: [diagramSchema(), errorSchema()] },
        render: (_args, value) =>
          'error' in value
            ? [{ type: 'text', text: value.error }]
            : [{ type: 'text', text: `"${value.title}" — ${String(value.nodes.length)} nodes, ${String(value.edges.length)} edges` }],
      },
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          return readDiagram(project, id)
        }),
    }),
    defineTool({
      name: 'arch_create',
      description: 'Create a new, empty diagram. Fails rather than overwriting one that exists.',
      parameters: {
        ...WORKSPACE_PARAM,
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
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
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
        ...WORKSPACE_PARAM,
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
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
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
        ...WORKSPACE_PARAM,
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
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const query = args['query']
          return listIcons(project, typeof query === 'string' ? query : undefined)
        }),
    }),
    defineTool({
      name: 'arch_screenshot',
      description:
        'See a diagram as it is actually drawn — box positions, overlaps, label readability, connector crossings. ' +
        'None of that is visible in the JSON. Use it to CHECK a layout and report what you see; you cannot ' +
        'rearrange the diagram yourself.',
      parameters: {
        ...WORKSPACE_PARAM,
        id: { type: 'string', description: 'The diagram id.' },
        view: {
          type: 'string',
          enum: ['viewport', 'whole'],
          description: 'What the user currently sees, or the whole diagram fitted. Defaults to viewport.',
        },
      },
      output: {
        schema: {
          oneOf: [
            { type: 'object', additionalProperties: false, properties: { note: { type: 'string', required: true } } },
            errorSchema(),
          ],
        },
        render: (_args, value) => [{ type: 'text', text: 'error' in value ? value.error : value.note }],
      },
      // Plan 2 replaces this body with a real capture. Until the designer
      // exists there is nothing to photograph, and saying so is the honest
      // answer — returning a blank canvas would be analysed as if it were real.
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          readDiagram(project, id)
          return { note: 'The designer has never been opened for this diagram, so there is no rendered view to show.' }
        }),
    }),
  ]
}

/**
 * Register every tool, disposing with the calling fiber.
 * @param ctx - a context carrying the tool registry.
 * @param workspaces - the workspace registry, narrowed.
 */
export function registerArchTools(ctx: { tools: ToolHost }, workspaces: WorkspaceLookup): void {
  for (const tool of archTools(workspaces)) ctx.tools.register(tool)
}
