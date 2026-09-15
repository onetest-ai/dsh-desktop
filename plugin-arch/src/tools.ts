import { applyEdit, type EditOps } from './edit.ts'
import { listIcons } from './icons.ts'
import type { WorkspaceLookup } from './rpc.ts'
import { createDiagram, listDiagrams, readDiagram, writeDiagram } from './store.ts'
import type { ToolHost } from './context.ts'

/**
 * The part of a tool definition this plugin supplies.
 *
 * Re-declared narrowly rather than imported from `dsh-tools`: the registry's
 * own `ToolDefinition` carries output declarations, presentation callbacks and
 * concurrency classifiers this plugin does not use, and compiling against the
 * shape actually supplied keeps a change there from breaking this build.
 */
export interface ArchToolDefinition {
  name: string
  description: string
  parameters: object
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** Every tool takes the workspace; the project path is never a parameter. */
const WORKSPACE_PARAM = {
  workspaceId: { type: 'string', description: 'The workspace whose diagrams to act on.' },
} as const

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
async function withProject(
  workspaces: WorkspaceLookup,
  args: Record<string, unknown>,
  body: (project: string) => unknown,
): Promise<unknown> {
  const resolved = projectOf(workspaces, args)
  if ('error' in resolved) return resolved
  try {
    return await body(resolved.path)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The six tools.
 *
 * NONE of them accepts coordinates, and none pins, unpins, or runs layout.
 * Placement is inferred and a human drag pins it; an agent assigning x/y would
 * produce layouts that are technically valid and visually worthless, and would
 * overwrite deliberate human placement. `arch_screenshot` is how the agent
 * CHECKS a layout — it looks and reports, rather than rearranging.
 * @param workspaces - the workspace registry, narrowed.
 * @returns the tool definitions, ready to register.
 */
export function archTools(workspaces: WorkspaceLookup): ArchToolDefinition[] {
  return [
    {
      name: 'arch_list',
      description:
        'Every architecture diagram in the project, each with an index of its nodes (id, name, type). ' +
        'Call this FIRST: it shows which diagram a thing belongs on and whether an id is already taken, ' +
        'so you neither read every file nor create a duplicate box under a new id.',
      parameters: { type: 'object', properties: { ...WORKSPACE_PARAM }, required: ['workspaceId'] },
      execute: async (args) => withProject(workspaces, args, (project) => listDiagrams(project)),
    },
    {
      name: 'arch_read',
      description: 'One diagram in full, including its edges and each node’s current geometry.',
      parameters: {
        type: 'object',
        properties: { ...WORKSPACE_PARAM, id: { type: 'string', description: 'The diagram id.' } },
        required: ['workspaceId', 'id'],
      },
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          return readDiagram(project, id)
        }),
    },
    {
      name: 'arch_create',
      description: 'Create a new, empty diagram. Fails rather than overwriting one that exists.',
      parameters: {
        type: 'object',
        properties: {
          ...WORKSPACE_PARAM,
          id: { type: 'string', description: 'A short slug, used as the file name.' },
          title: { type: 'string', description: 'The display title.' },
        },
        required: ['workspaceId', 'id', 'title'],
      },
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          const title = requiredArg(args, 'title')
          if (title === undefined) return { error: 'missing title' }
          return createDiagram(project, id, title)
        }),
    },
    {
      name: 'arch_edit',
      description:
        'Apply a batch of changes to one diagram in a single call: add, update and remove nodes and edges together. ' +
        'ALWAYS send a new node and its connections in the SAME call — new nodes are positioned next to the ' +
        'neighbours they connect to, so a node added without its edges is placed before anything is known about ' +
        'it and ends up in a corner. Node ids should be stable, human-meaningful slugs (paypal, not n-7), and the ' +
        'same real-world thing should reuse its id across diagrams.',
      parameters: {
        type: 'object',
        properties: {
          ...WORKSPACE_PARAM,
          id: { type: 'string', description: 'The diagram id.' },
          ops: {
            type: 'object',
            description: 'The changes. Applied as removals, then additions, then updates, then placement.',
            properties: {
              addNodes: {
                type: 'array',
                description: 'Nodes to add. No coordinates: placement assigns them.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    type: {
                      type: 'string',
                      description:
                        'A free-form label shown under the name, e.g. "System", "Actor", ' +
                        '"External system: QuickBooks". Any string is valid.',
                    },
                    icon: { type: 'string', description: 'A slug from arch_icons, e.g. "okta" or "custom:aws/ec2".' },
                    status: { type: 'string', enum: ['live', 'future', 'deprecated', 'removed'] },
                    description: { type: 'string' },
                    childDiagram: { type: 'string', description: 'A diagram id to drill into from this node.' },
                  },
                  required: ['id', 'name', 'type'],
                },
              },
              updateNodes: {
                type: 'array',
                description:
                  'Changes to existing nodes. Geometry is deliberately absent — you cannot move a box.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'The node to change.' },
                    name: { type: 'string' },
                    type: { type: 'string' },
                    icon: { type: 'string' },
                    status: { type: 'string', enum: ['live', 'future', 'deprecated', 'removed'] },
                    description: { type: 'string' },
                    childDiagram: { type: 'string' },
                  },
                  required: ['id'],
                },
              },
              removeNodes: {
                type: 'array',
                description: 'Node ids to remove. Every edge touching them goes too.',
                items: { type: 'string' },
              },
              addEdges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    label: { type: 'string', description: 'Prose, e.g. "Liz attaches PDF invoice to email".' },
                    sublabel: { type: 'string', description: 'A grey qualifier, e.g. "Implied".' },
                    direction: { type: 'string', enum: ['outgoing', 'bidirectional', 'none'] },
                  },
                  required: ['from', 'to'],
                },
              },
              removeEdges: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['workspaceId', 'id', 'ops'],
      },
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          const next = applyEdit(readDiagram(project, id), (args['ops'] ?? {}) as EditOps)
          writeDiagram(project, id, next)
          return next
        }),
    },
    {
      name: 'arch_icons',
      description:
        'Search the icons available to this project — the bundled set plus anything under .dsh/arch/icons/ ' +
        'and the folders named in .dsh/arch/config.json. Always pass a query: an icon pack can run to a ' +
        'thousand files. You cannot add icons; that is done by hand in the designer.',
      parameters: {
        type: 'object',
        properties: {
          ...WORKSPACE_PARAM,
          query: { type: 'string', description: 'Case-insensitive substring of the slug.' },
        },
        required: ['workspaceId'],
      },
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const query = args['query']
          return listIcons(project, typeof query === 'string' ? query : undefined)
        }),
    },
    {
      name: 'arch_screenshot',
      description:
        'See a diagram as it is actually drawn — box positions, overlaps, label readability, connector crossings. ' +
        'None of that is visible in the JSON. Use it to CHECK a layout and report what you see; you cannot ' +
        'rearrange the diagram yourself.',
      parameters: {
        type: 'object',
        properties: {
          ...WORKSPACE_PARAM,
          id: { type: 'string', description: 'The diagram id.' },
          view: {
            type: 'string',
            enum: ['viewport', 'whole'],
            description: 'What the user currently sees, or the whole diagram fitted. Defaults to viewport.',
          },
        },
        required: ['workspaceId', 'id'],
      },
      // Plan 2 replaces this body with a real capture. Until the designer
      // exists there is nothing to photograph, and saying so is the honest
      // answer — returning a blank canvas would be analysed as if it were real.
      execute: async (args) =>
        withProject(workspaces, args, (project) => {
          const id = requiredArg(args, 'id')
          if (id === undefined) return { error: 'missing id' }
          readDiagram(project, id)
          return {
            image: undefined,
            note: 'The designer has never been opened for this diagram, so there is no rendered view to show.',
          }
        }),
    },
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
