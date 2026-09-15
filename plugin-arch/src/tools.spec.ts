import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { archTools } from './tools.ts'
import type { WorkspaceLookup } from './rpc.ts'

let project: string
let tools: Map<string, ToolDefinition>

// None of this plugin's tools reads `exec` (no nested dispatch, no deferred
// context, no turn-concluding), so an empty stub satisfies every call site
// that matters here without impersonating the real registry's execution
// bookkeeping.
const FAKE_EXEC = {} as ToolRunContext

/**
 * @param name - the tool name.
 * @param args - its arguments, with workspaceId filled in.
 * @returns whatever the tool returns.
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.execute({ workspaceId: 'ws1', ...args }, FAKE_EXEC)
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'tools-'))
  const workspaces: WorkspaceLookup = { get: (id) => (id === 'ws1' ? { path: project } : undefined) }
  tools = new Map(archTools(workspaces).map((tool) => [tool.name, tool]))
})

describe('the tool set', () => {
  it('is exactly the six tools the design names', () => {
    expect([...tools.keys()].sort()).toEqual([
      'arch_create',
      'arch_edit',
      'arch_icons',
      'arch_list',
      'arch_read',
      'arch_screenshot',
    ])
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

describe('arch_screenshot', () => {
  it('says the designer has never been opened rather than returning nothing', async () => {
    await call('arch_create', { id: 'auth', title: 'Auth' })
    const result = (await call('arch_screenshot', { id: 'auth' })) as { image?: unknown; note: string }
    expect(result.image).toBeUndefined()
    expect(result.note).toMatch(/never been opened|not open/i)
  })
})
