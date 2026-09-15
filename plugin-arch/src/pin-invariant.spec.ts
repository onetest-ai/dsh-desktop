import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { archRoot } from './paths.ts'
import { createArchHandler, type WorkspaceLookup } from './rpc.ts'
import { archTools } from './tools.ts'

/**
 * The product's one promise, tested at the seam.
 *
 * Every other spec in this package exercises a pure module. This one drives the
 * REAL agent tools and the REAL RPC handler against a real temp project, and
 * that difference is the point: each of the defects this file was written for —
 * an edit writing a file the parser then refused, a remove-and-re-add losing a
 * position, a duplicate id letting a no-op edit unpin a node, an overwrite
 * refused for a name read and delete accept — lived in a seam between two
 * modules that were each individually correct. None was catchable by reviewing
 * one module; all of them fail this file.
 *
 * The assertion is always the same and always exact: after whatever was done,
 * the node the user placed is byte-identical to what was written.
 */

/** Where the user "dragged" the node to. Chosen far from any spot placement picks. */
const PINNED = { id: 'frontend', name: 'Frontend', type: 'App', x: 900, y: 900, w: 240, h: 130, pinned: true } as const

let project: string
let handle: ReturnType<typeof createArchHandler>
let tools: Map<string, ToolDefinition>
let exec: ToolRunContext

/**
 * Call one agent tool against the fixture workspace.
 * @param name - the tool name.
 * @param args - its arguments.
 * @returns whatever the tool returns.
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.execute(args, exec)
}

/**
 * Read the pinned node back through `arch_read` — the tool, not the store, so a
 * regression anywhere between the file and the agent is caught.
 * @returns the node as the agent would see it.
 */
async function pinnedNode(): Promise<Record<string, unknown>> {
  const read = (await call('arch_read', { id: 'auth' })) as { nodes?: Array<Record<string, unknown>> }
  expect(read.nodes, `arch_read failed: ${JSON.stringify(read)}`).toBeDefined()
  const node = read.nodes?.find((candidate) => candidate['id'] === 'frontend')
  expect(node, 'the pinned node is gone').toBeDefined()
  return node as Record<string, unknown>
}

/** Assert the pinned node is exactly where the user put it. */
async function expectUnmoved(): Promise<void> {
  const node = await pinnedNode()
  expect({
    x: node['x'],
    y: node['y'],
    w: node['w'],
    h: node['h'],
    pinned: node['pinned'],
  }).toEqual({ x: PINNED.x, y: PINNED.y, w: PINNED.w, h: PINNED.h, pinned: PINNED.pinned })
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'pin-'))
  const workspaces: WorkspaceLookup = { get: (id) => (id === 'ws1' ? { path: project } : undefined) }
  handle = createArchHandler(workspaces)
  tools = new Map(archTools().map((tool) => [tool.name, tool]))
  // The RPC channel still resolves by workspaceId (`handle`, below); the
  // agent tools resolve the project from the session's own cwd instead.
  exec = { agent: { session: { meta: { cwd: project } } } } as unknown as ToolRunContext

  await call('arch_create', { id: 'auth', title: 'Auth' })
  await call('arch_edit', {
    id: 'auth',
    ops: {
      addNodes: [
        { id: 'frontend', name: 'Frontend', type: 'App' },
        { id: 'user-store', name: 'User store', type: 'Store' },
      ],
      addEdges: [{ from: 'frontend', to: 'user-store' }],
    },
  })

  // The pin: an explicit position written the way the canvas writes one. This
  // is the only way a node becomes pinned — no tool can do it, by design.
  const read = (await call('arch_read', { id: 'auth' })) as { nodes: Array<Record<string, unknown>>; edges: unknown[] }
  const written = await handle('diagram/write', {
    workspaceId: 'ws1',
    id: 'auth',
    diagram: {
      title: 'Auth',
      nodes: read.nodes.map((node) => (node['id'] === 'frontend' ? { ...node, ...PINNED } : node)),
      edges: read.edges,
    },
  })
  expect(written).toEqual({ ok: true, value: null })
})

describe('a node the user placed', () => {
  it('starts where it was put', async () => {
    await expectUnmoved()
  })

  it('survives adding a neighbour', async () => {
    expect(await call('arch_edit', { id: 'auth', ops: { addNodes: [{ id: 'sso', name: 'SSO', type: 'External' }] } }))
      .not.toHaveProperty('error')
    await expectUnmoved()
  })

  it('survives adding a neighbour wired straight to it', async () => {
    // The case placement actually reasons about: the new node's preferred spot
    // is computed FROM this node, so an off-by-one there would move it.
    await call('arch_edit', {
      id: 'auth',
      ops: {
        addNodes: [{ id: 'sso', name: 'SSO', type: 'External' }],
        addEdges: [{ from: 'frontend', to: 'sso' }],
      },
    })
    await expectUnmoved()
  })

  it('survives adding an edge on its own', async () => {
    await call('arch_edit', { id: 'auth', ops: { addEdges: [{ from: 'user-store', to: 'frontend' }] } })
    await expectUnmoved()
  })

  it('survives a semantic update to itself', async () => {
    await call('arch_edit', {
      id: 'auth',
      ops: { updateNodes: [{ id: 'frontend', name: 'Web app', status: 'deprecated', description: 'Rewritten' }] },
    })
    const node = await pinnedNode()
    expect(node['name']).toBe('Web app')
    await expectUnmoved()
  })

  it('survives removing an unrelated node', async () => {
    await call('arch_edit', { id: 'auth', ops: { removeNodes: ['user-store'] } })
    await expectUnmoved()
  })

  it('survives being removed and re-added under the same id in one call', async () => {
    await call('arch_edit', {
      id: 'auth',
      ops: {
        removeNodes: ['frontend'],
        addNodes: [{ id: 'frontend', name: 'Rebuilt', type: 'Service' }],
      },
    })
    expect((await pinnedNode())['name']).toBe('Rebuilt')
    await expectUnmoved()
  })

  it('survives an empty ops', async () => {
    await call('arch_edit', { id: 'auth', ops: {} })
    await expectUnmoved()
  })

  it.each([
    ['a node with no id, name or type', { addNodes: [{ nonsense: 1 }] }],
    ['a status outside the declared enum', { addNodes: [{ id: 'sso', name: 'SSO', type: 'T', status: 'bogus' }] }],
    ['a non-string name on an update', { updateNodes: [{ id: 'frontend', name: 42 }] }],
    ['ops that is not an object at all', 'nonsense'],
    ['an ops field of the wrong type', { addNodes: {} }],
  ])('survives %s, which is refused rather than written', async (_case, ops) => {
    const result = (await call('arch_edit', { id: 'auth', ops })) as Record<string, unknown>
    expect(result['error'], 'a malformed edit must be reported, not applied').toEqual(expect.any(String))
    await expectUnmoved()
  })

  it('survives a diagram/write round trip', async () => {
    // What the canvas does on every settle: read the whole diagram, write it
    // back. The bytes must not drift, or a save would walk a pinned node.
    const before = readFileSync(join(archRoot(project), 'auth.json'), 'utf8')
    const read = (await call('arch_read', { id: 'auth' })) as object
    const written = await handle('diagram/write', { workspaceId: 'ws1', id: 'auth', diagram: read })
    expect(written).toEqual({ ok: true, value: null })
    expect(readFileSync(join(archRoot(project), 'auth.json'), 'utf8')).toBe(before)
    await expectUnmoved()
  })

  it('cannot be unpinned by a duplicate id smuggled in through diagram/write', async () => {
    // The duplicate let one freshly-placed node overwrite every node sharing
    // its id, so a subsequent no-op edit moved a pinned box to (0,0). The write
    // is refused, so the state that made that possible never exists.
    const read = (await call('arch_read', { id: 'auth' })) as { nodes: object[]; edges: unknown[] }
    const result = await handle('diagram/write', {
      workspaceId: 'ws1',
      id: 'auth',
      diagram: {
        title: 'Auth',
        nodes: [...read.nodes, { id: 'frontend', name: 'Impostor', type: 'App', w: 200, h: 100 }],
        edges: read.edges,
      },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    await call('arch_edit', { id: 'auth', ops: {} })
    await expectUnmoved()
  })

  it('is still saveable when the diagram file has a name the store would not create', async () => {
    // Read, list and delete all accept a hand-made `_legacy.json`; write used
    // to refuse it, so the canvas could never save a drag on such a diagram and
    // would retry forever against a message about naming.
    const legacy = {
      title: 'Legacy',
      nodes: [{ ...PINNED }],
      edges: [],
    }
    // Created directly, because by construction this module cannot create it.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), '_legacy.json'), `${JSON.stringify(legacy, null, 2)}\n`)

    const written = await handle('diagram/write', {
      workspaceId: 'ws1',
      id: '_legacy',
      diagram: { ...legacy, title: 'Legacy, renamed' },
    })
    expect(written).toEqual({ ok: true, value: null })

    const read = (await call('arch_read', { id: '_legacy' })) as { title: string; nodes: Array<Record<string, unknown>> }
    expect(read.title).toBe('Legacy, renamed')
    expect(read.nodes[0]).toMatchObject({ x: PINNED.x, y: PINNED.y, pinned: true })
  })
})
