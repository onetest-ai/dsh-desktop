import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
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
    const result = await handle('icon/list', { workspaceId: 'ws1', query: 'nothing' })
    expect(result).toEqual({ ok: true, value: [] })
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
})
