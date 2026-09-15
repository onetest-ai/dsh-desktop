import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { archTools } from './tools.ts'

let project: string
let tools: Map<string, ToolDefinition>
let exec: ToolRunContext

/**
 * @param name - the tool name.
 * @param args - its arguments.
 * @returns whatever the tool returns.
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.execute(args, exec)
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'tools-'))
  tools = new Map(archTools().map((tool) => [tool.name, tool]))
  // A fake session, exactly as loosely-shaped as the real one this plugin
  // reads at runtime: `exec.agent.session.meta.cwd`. No `workspaceId` appears
  // anywhere — the project comes from here, not from an argument.
  exec = { agent: { session: { meta: { cwd: project } } } } as unknown as ToolRunContext
})

describe('the tool set', () => {
  it('is exactly the five tools the design names', () => {
    expect([...tools.keys()].sort()).toEqual(['arch_create', 'arch_edit', 'arch_icons', 'arch_list', 'arch_read'])
  })

  it('registers no arch_screenshot', () => {
    // Returns in Plan 2, alongside the canvas: a tool that can only ever say
    // "there is nothing to render yet" sent the model looking for a view via
    // browser automation on the app's own UI instead. Re-adding this before
    // there is something to actually capture repeats that failure.
    expect(tools.has('arch_screenshot')).toBe(false)
  })

  it('exposes no tool that pins, unpins, or lays out', () => {
    // The human's lever over the machine's output. Handing the machine its own
    // lever defeats the point of having one.
    const names = [...tools.keys()].join(' ')
    expect(names).not.toMatch(/pin|layout|place|position|move/i)
  })

  it('accepts no coordinate parameter anywhere', () => {
    for (const tool of tools.values()) {
      expect(JSON.stringify(tool.parameters)).not.toMatch(/"(x|y)"/)
    }
  })

  it('declares the mandatory output contract the real registry enforces', () => {
    // dsh-tools/lib/index.js refuses `register` for any definition whose
    // `output` is not `{ schema, render }` — this is the failure that reached
    // the user when this plugin was built against a hand-written stand-in for
    // the real contract instead of `defineTool`.
    for (const tool of tools.values()) {
      expect(typeof tool.output.render).toBe('function')
      expect(typeof tool.output.schema).toBe('object')
    }
  })

  it('takes no workspaceId parameter anywhere', () => {
    // The regression this fix exists to prevent: the model has no way to
    // discover a workspace id (no tool lists them, they are opaque registry
    // keys), so every call failed until the project came from the session
    // instead of an argument.
    for (const tool of tools.values()) {
      expect(tool.parameters).not.toHaveProperty('workspaceId')
    }
  })
})

describe('a tool call with no workspaceId argument at all', () => {
  it('still resolves the project, from the session', async () => {
    // Exactly the shape a real call arrives in: no workspaceId, ever.
    const result = (await call('arch_create', { id: 'auth', title: 'Auth' })) as { title?: string }
    expect(result.title).toBe('Auth')
  })
})

describe('the SSO scenario', () => {
  it('adds a connected node in four calls', async () => {
    await call('arch_create', { id: 'auth', title: 'Auth' })
    await call('arch_edit', {
      id: 'auth',
      ops: {
        addNodes: [
          { id: 'frontend', name: 'Frontend', type: 'App' },
          { id: 'user-store', name: 'User store', type: 'Store' },
        ],
      },
    })

    // 1. the index — which diagram, and does SSO already exist?
    const index = (await call('arch_list')) as Array<{ id: string; nodes: Array<{ id: string }> }>
    expect(index[0]?.nodes.map((node) => node.id)).toEqual(['frontend', 'user-store'])

    // 2. the chosen diagram in full
    await call('arch_read', { id: 'auth' })

    // 3. ONE edit: the node and its edges together, so placement sees them
    const edited = (await call('arch_edit', {
      id: 'auth',
      ops: {
        addNodes: [{ id: 'sso', name: 'SSO', type: 'External system: Okta' }],
        addEdges: [
          { from: 'frontend', to: 'sso' },
          { from: 'sso', to: 'user-store' },
        ],
      },
    })) as { nodes: Array<{ id: string; x?: number; pinned: boolean }>; edges: unknown[] }

    const sso = edited.nodes.find((node) => node.id === 'sso')
    expect(typeof sso?.x).toBe('number')
    expect(sso?.pinned).toBe(false)
    expect(edited.edges).toHaveLength(2)
  })

  it('reports a failure as a message rather than throwing', async () => {
    const result = (await call('arch_read', { id: 'ghost' })) as { error?: string }
    expect(result.error).toMatch(/not found/)
  })

  it('names the missing argument rather than reporting a stringified "undefined"', async () => {
    const result = (await call('arch_read', {})) as { error?: string }
    expect(result.error).toBe('missing id')
  })

  it('reads an existing diagram as an untouched happy path', async () => {
    await call('arch_create', { id: 'auth', title: 'Auth' })
    const result = (await call('arch_read', { id: 'auth' })) as { title?: string }
    expect(result.title).toBe('Auth')
  })
})

describe('arch_create', () => {
  it('names the missing title rather than stringifying "undefined"', async () => {
    const result = (await call('arch_create', { id: 'auth' })) as { error?: string }
    expect(result.error).toBe('missing title')
  })
})

describe('lossless JSON', () => {
  it('arch_read on a node with no icon, status or description round-trips through JSON unchanged', async () => {
    // parseDiagram sets absent optional fields to an explicit `undefined`;
    // the real registry snapshots every return value through
    // `snapshotJsonValue`, which refuses anything that cannot round-trip —
    // this is the assertion that would have caught `value is not lossless
    // JSON` before it reached the user.
    await call('arch_create', { id: 'auth', title: 'Auth' })
    await call('arch_edit', { id: 'auth', ops: { addNodes: [{ id: 'bare', name: 'Bare', type: 'App' }] } })
    const result = await call('arch_read', { id: 'auth' })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('arch_read render', () => {
  it('renders a Mermaid flowchart with a summary line', async () => {
    await call('arch_create', { id: 'payments', title: 'Payments' })
    await call('arch_edit', {
      id: 'payments',
      ops: {
        addNodes: [
          { id: 'customer', name: 'Customer', type: 'Actor' },
          { id: 'checkout', name: 'Checkout Service', type: 'App' },
          { id: 'stripe', name: 'Stripe', type: 'External system: Stripe' },
        ],
        addEdges: [
          { from: 'customer', to: 'checkout', label: 'submits checkout/card payment' },
          { from: 'checkout', to: 'stripe', label: 'creates the card charge' },
        ],
      },
    })
    const tool = tools.get('arch_read')!
    const value = await tool.execute({ id: 'payments' }, exec)
    const rendered = tool.output.render({ id: 'payments' }, value)
    expect(rendered).toEqual([{ type: 'text', text: expect.stringContaining('```mermaid') }])
    const text = (rendered[0] as { text: string }).text
    expect(text).toMatch(/^Payments — 3 nodes, 2 edges/)
    expect(text).toContain('flowchart TD')
    expect(text).toContain('customer["Customer<br/>[Actor]"]')
    expect(text).toContain('customer -->|"submits checkout/card payment"| checkout')
  })

  it('renders "(no nodes yet)" with no fence for an empty diagram', async () => {
    await call('arch_create', { id: 'empty', title: 'Empty' })
    const tool = tools.get('arch_read')!
    const value = await tool.execute({ id: 'empty' }, exec)
    const rendered = tool.output.render({ id: 'empty' }, value)
    const text = (rendered[0] as { text: string }).text
    expect(text).toBe('Empty — 0 nodes, 0 edges\n(no nodes yet)')
    expect(text).not.toContain('```')
  })
})

