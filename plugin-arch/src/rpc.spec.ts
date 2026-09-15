import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { archRoot } from './paths.ts'
import { createArchHandler, type WorkspaceLookup } from './rpc.ts'

let project: string
let handle: ReturnType<typeof createArchHandler>

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'rpc-'))
  const workspaces: WorkspaceLookup = { get: (id) => (id === 'ws1' ? { path: project } : undefined) }
  handle = createArchHandler(workspaces)
})

describe('workspace resolution', () => {
  it('refuses an unknown workspace id with a coded failure', async () => {
    const result = await handle('diagram/list', { workspaceId: 'nope' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'unknown-workspace', message: 'unknown workspace "nope"', details: {} },
    })
  })

  it('ignores any path the caller tries to supply', async () => {
    // A path in the payload must never be honoured: that is arbitrary write.
    await handle('diagram/create', { workspaceId: 'ws1', id: 'a', title: 'A', path: '/tmp/elsewhere' })
    const listed = await handle('diagram/list', { workspaceId: 'ws1' })
    expect(listed).toEqual({ ok: true, value: [{ id: 'a', title: 'A', nodes: [] }] })
  })
})

describe('endpoints', () => {
  it('creates, reads, edits and deletes', async () => {
    await handle('diagram/create', { workspaceId: 'ws1', id: 'auth', title: 'Auth' })

    const edited = await handle('diagram/edit', {
      workspaceId: 'ws1',
      id: 'auth',
      ops: { addNodes: [{ id: 'sso', name: 'SSO', type: 'External' }] },
    })
    expect(edited).toMatchObject({ ok: true })

    const read = await handle('diagram/read', { workspaceId: 'ws1', id: 'auth' })
    expect(read).toMatchObject({ ok: true, value: { title: 'Auth' } })

    const deleted = await handle('diagram/delete', { workspaceId: 'ws1', id: 'auth' })
    expect(deleted).toEqual({ ok: true, value: null })
  })

  it('lists icons', async () => {
    // An empty project answering `[]` proves nothing: an endpoint wired to
    // nothing at all returns the same. A real file on disk and a query that
    // matches it is what shows `icon/list` reaches `listIcons`.
    mkdirSync(join(archRoot(project), 'icons'), { recursive: true })
    writeFileSync(join(archRoot(project), 'icons', 'okta.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')

    const hit = await handle('icon/list', { workspaceId: 'ws1', query: 'okt' })
    expect(hit).toEqual({ ok: true, value: [{ slug: 'okta', mediaType: 'image/svg+xml' }] })

    const miss = await handle('icon/list', { workspaceId: 'ws1', query: 'nothing' })
    expect(miss).toEqual({ ok: true, value: [] })
  })

  it('reports an unknown endpoint rather than throwing', async () => {
    const result = await handle('diagram/explode', { workspaceId: 'ws1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-endpoint' } })
  })

  it('turns a store failure into an error result, not a rejection', async () => {
    const result = await handle('diagram/read', { workspaceId: 'ws1', id: 'ghost' })
    expect(result).toMatchObject({ ok: false, error: { code: 'store-error' } })
    expect((result as { error: { message: string } }).error.message).toMatch(/not found/)
  })

  it('always returns a structured failure, never a bare string', async () => {
    // ConnectionRpcResult requires { code, message, details }; a string does
    // not satisfy it, and the transport would reject the envelope.
    for (const bad of [
      handle('diagram/read', { workspaceId: 'ws1' }),
      handle('diagram/create', { workspaceId: 'ws1', id: 'x' }),
      handle('nope/nope', { workspaceId: 'ws1' }),
    ]) {
      const result = (await bad) as { ok: false; error: unknown }
      expect(typeof result.error).toBe('object')
      expect(result.error).toMatchObject({ code: expect.any(String), message: expect.any(String) })
    }
  })

  it('refuses a diagram id that escapes the arch directory', async () => {
    const result = await handle('diagram/create', { workspaceId: 'ws1', id: '../escape', title: 'X' })
    expect(result).toMatchObject({ ok: false })
  })

  it('writes a whole diagram and reads it back', async () => {
    const written = await handle('diagram/write', {
      workspaceId: 'ws1',
      id: 'canvas',
      diagram: { title: 'Canvas', nodes: [], edges: [] },
    })
    expect(written).toEqual({ ok: true, value: null })

    const read = await handle('diagram/read', { workspaceId: 'ws1', id: 'canvas' })
    expect(read).toMatchObject({ ok: true, value: { title: 'Canvas', nodes: [], edges: [] } })
  })

  it('refuses diagram/write for an id the store refuses to create', async () => {
    const result = await handle('diagram/write', {
      workspaceId: 'ws1',
      id: 'a/b',
      diagram: { title: 'X', nodes: [], edges: [] },
    })
    expect(result).toMatchObject({ ok: false })
  })

  it('refuses diagram/write with no title, and leaves no file behind', async () => {
    // The old behaviour: serializeDiagram reads title unguarded, JSON.stringify
    // drops the undefined, and the call reported ok having written a file every
    // subsequent read then refused. The error code alone would not catch a
    // regression that still writes the corrupt file — the read below is the
    // assertion that matters.
    const result = await handle('diagram/write', {
      workspaceId: 'ws1',
      id: 'canvas',
      diagram: { nodes: [], edges: [] },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const read = await handle('diagram/read', { workspaceId: 'ws1', id: 'canvas' })
    expect(read).toMatchObject({ ok: false, error: { code: 'store-error' } })
    expect((read as { error: { message: string } }).error.message).toMatch(/not found/)
  })

  it('refuses a grossly wrong diagram shape as bad-request, not internal', async () => {
    const result = await handle('diagram/write', { workspaceId: 'ws1', id: 'canvas', diagram: 42 })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
})

describe('error classification', () => {
  it('maps an EditError to bad-request', async () => {
    await handle('diagram/create', { workspaceId: 'ws1', id: 'auth', title: 'Auth' })
    const result = await handle('diagram/edit', {
      workspaceId: 'ws1',
      id: 'auth',
      ops: { addEdges: [{ from: 'ghost', to: 'also-ghost' }] },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('maps a StoreError to store-error', async () => {
    // The existing "not found" read already exercises this path; confirmed
    // here under its own name so the classification has a direct test.
    const result = await handle('diagram/read', { workspaceId: 'ws1', id: 'ghost' })
    expect(result).toMatchObject({ ok: false, error: { code: 'store-error' } })
  })

  it('rejects a wrong-shaped ops field rather than silently doing nothing', async () => {
    await handle('diagram/create', { workspaceId: 'ws1', id: 'auth', title: 'Auth' })
    // `('nonsense').addNodes` and `(42).addNodes` are both `undefined`, so
    // without applyEdit's own validation every field falls back to empty and
    // the call reports success having changed nothing — an agent told "ok"
    // for an edit that silently did not happen. These are the exact inputs
    // that produced that hole.
    for (const ops of ['nonsense', 42]) {
      const result = await handle('diagram/edit', { workspaceId: 'ws1', id: 'auth', ops })
      expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
  })

  it('rejects a non-array field inside ops', async () => {
    await handle('diagram/create', { workspaceId: 'ws1', id: 'auth', title: 'Auth' })
    // `addNodes` cast straight through from the payload with no shape
    // validation; an object here is not an array, so applyEdit's own check
    // throws an EditError naming the field, which classifies as bad-request.
    const result = await handle('diagram/edit', {
      workspaceId: 'ws1',
      id: 'auth',
      ops: { addNodes: {} },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect((result as { error: { message: string } }).error.message).toMatch(/ops\.addNodes/)
  })

  it.each([
    ['a node with no id, name or type', { addNodes: [{ nonsense: 1 }] }],
    ['a status outside the enum the schema declares', { addNodes: [{ id: 'a', name: 'A', type: 'T', status: 'bogus' }] }],
    ['a non-string name on an update', { updateNodes: [{ id: 'frontend', name: 42 }] }],
    ['a removal id that is not a string', { removeNodes: [7] }],
  ])('refuses %s and leaves the file readable', async (_case, ops) => {
    // The whole defect in one shape: these all reported ok, were written to
    // disk, and made the diagram unreadable from then on. The read afterwards
    // is the assertion that matters — a regression that still writes the
    // corrupt file would pass an error-code check alone.
    await handle('diagram/create', { workspaceId: 'ws1', id: 'auth', title: 'Auth' })
    await handle('diagram/edit', {
      workspaceId: 'ws1',
      id: 'auth',
      ops: { addNodes: [{ id: 'frontend', name: 'Frontend', type: 'App' }] },
    })

    const result = await handle('diagram/edit', { workspaceId: 'ws1', id: 'auth', ops })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    const read = await handle('diagram/read', { workspaceId: 'ws1', id: 'auth' })
    expect(read).toMatchObject({ ok: true, value: { title: 'Auth' } })
    expect((read as { value: { nodes: unknown[] } }).value.nodes).toHaveLength(1)
  })

  it('accepts an empty ops object as a genuine no-op', async () => {
    await handle('diagram/create', { workspaceId: 'ws1', id: 'auth', title: 'Auth' })
    const result = await handle('diagram/edit', { workspaceId: 'ws1', id: 'auth', ops: {} })
    expect(result).toMatchObject({ ok: true })
  })
})
