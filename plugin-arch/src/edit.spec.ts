import { describe, expect, it } from 'vitest'
import { applyEdit, EditError } from './edit.ts'
import type { Diagram } from './diagram.ts'

const BASE: Diagram = {
  title: 'Auth',
  nodes: [
    { id: 'frontend', name: 'Frontend', type: 'App', x: 0, y: 0, w: 200, h: 100, pinned: true },
    { id: 'user-store', name: 'User store', type: 'Store', x: 0, y: 600, w: 200, h: 100, pinned: true },
  ],
  edges: [],
}

describe('applyEdit', () => {
  it('adds a node and gives it coordinates', () => {
    const out = applyEdit(BASE, { addNodes: [{ id: 'sso', name: 'SSO', type: 'External system: Okta' }] })
    const sso = out.nodes.find((n) => n.id === 'sso')
    expect(sso?.name).toBe('SSO')
    expect(typeof sso?.x).toBe('number')
    expect(sso?.pinned).toBe(false)
  })

  it('places an added node using edges added in the SAME call', () => {
    const together = applyEdit(BASE, {
      addNodes: [{ id: 'sso', name: 'SSO', type: 'External' }],
      addEdges: [{ from: 'frontend', to: 'sso' }, { from: 'sso', to: 'user-store' }],
    })
    const batched = together.nodes.find((n) => n.id === 'sso')

    // The same work split across calls: the node is placed before it has any
    // edges, which is exactly the failure batching exists to prevent.
    const step1 = applyEdit(BASE, { addNodes: [{ id: 'sso', name: 'SSO', type: 'External' }] })
    const split = applyEdit(step1, {
      addEdges: [{ from: 'frontend', to: 'sso' }, { from: 'sso', to: 'user-store' }],
    }).nodes.find((n) => n.id === 'sso')

    expect(batched?.y).toBeGreaterThan(0)
    expect(batched?.y).not.toBe(split?.y)
  })

  it('updates a node without moving it', () => {
    const out = applyEdit(BASE, { updateNodes: [{ id: 'frontend', name: 'Web app' }] })
    const front = out.nodes.find((n) => n.id === 'frontend')
    expect(front?.name).toBe('Web app')
    expect(front?.x).toBe(0)
    expect(front?.pinned).toBe(true)
  })

  it('removes a node and every edge touching it', () => {
    const wired = applyEdit(BASE, { addEdges: [{ from: 'frontend', to: 'user-store' }] })
    const out = applyEdit(wired, { removeNodes: ['user-store'] })
    expect(out.nodes.map((n) => n.id)).toEqual(['frontend'])
    expect(out.edges).toEqual([])
  })

  it('gives added edges stable, unique ids', () => {
    const out = applyEdit(BASE, { addEdges: [{ from: 'frontend', to: 'user-store' }] })
    const again = applyEdit(out, { addEdges: [{ from: 'user-store', to: 'frontend' }] })
    const ids = again.edges.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('defaults an edge direction to outgoing', () => {
    const out = applyEdit(BASE, { addEdges: [{ from: 'frontend', to: 'user-store' }] })
    expect(out.edges[0]?.direction).toBe('outgoing')
  })

  it.each([
    ['a duplicate node id', { addNodes: [{ id: 'frontend', name: 'X', type: 'App' }] }],
    ['an edge from an unknown node', { addEdges: [{ from: 'ghost', to: 'frontend' }] }],
    ['an edge to an unknown node', { addEdges: [{ from: 'frontend', to: 'ghost' }] }],
    ['an update to an unknown node', { updateNodes: [{ id: 'ghost', name: 'X' }] }],
    ['removing an unknown node', { removeNodes: ['ghost'] }],
  ])('rejects %s', (_case, ops) => {
    expect(() => applyEdit(BASE, ops)).toThrow(EditError)
  })

  it('applies removals before additions so a node can be replaced in one call', () => {
    const out = applyEdit(BASE, {
      removeNodes: ['frontend'],
      addNodes: [{ id: 'frontend', name: 'Rebuilt', type: 'App' }],
    })
    expect(out.nodes.find((n) => n.id === 'frontend')?.name).toBe('Rebuilt')
  })

  it('keeps a replaced node exactly where it was', () => {
    // Replace-in-one-call used to return the node at (0,0), unpinned, at the
    // default size — undoing a placement the user made by hand, which the
    // README promises can never happen. Semantics change; geometry does not.
    const placed: Diagram = {
      title: 'Auth',
      nodes: [{ id: 'frontend', name: 'Frontend', type: 'App', x: 900, y: 900, w: 200, h: 100, pinned: true }],
      edges: [],
    }
    const out = applyEdit(placed, {
      removeNodes: ['frontend'],
      addNodes: [{ id: 'frontend', name: 'Rebuilt', type: 'Service' }],
    })
    expect(out.nodes[0]).toEqual({
      id: 'frontend',
      name: 'Rebuilt',
      type: 'Service',
      icon: undefined,
      status: undefined,
      description: undefined,
      childDiagram: undefined,
      parent: undefined,
      x: 900,
      y: 900,
      w: 200,
      h: 100,
      pinned: true,
    })
  })

  it('lets a replacement state a new size explicitly', () => {
    // The carry-forward is a default, not a lock: `w`/`h` sent with the
    // addition still win, or a legitimate resize would be impossible.
    const out = applyEdit(BASE, {
      removeNodes: ['frontend'],
      addNodes: [{ id: 'frontend', name: 'Rebuilt', type: 'App', w: 400, h: 300 }],
    })
    const front = out.nodes.find((n) => n.id === 'frontend')
    expect([front?.w, front?.h]).toEqual([400, 300])
    expect([front?.x, front?.y]).toEqual([0, 0])
  })

  it.each([
    ['a node with no id, name or type', { addNodes: [{ nonsense: 1 }] }, /ops\.addNodes\[0\]/],
    ['a node id that is not a string', { addNodes: [{ id: 7, name: 'A', type: 'T' }] }, /"id" must be a string/],
    ['an empty node name', { addNodes: [{ id: 'a', name: '', type: 'T' }] }, /"name" must not be empty/],
    ['a status outside its set', { addNodes: [{ id: 'a', name: 'A', type: 'T', status: 'bogus' }] }, /unknown status/],
    ['a non-finite w', { addNodes: [{ id: 'a', name: 'A', type: 'T', w: Number.NaN }] }, /"w" must be a finite number/],
    ['a non-string name on an update', { updateNodes: [{ id: 'frontend', name: 42 }] }, /"name" must be a string/],
    ['a direction outside its set', { addEdges: [{ from: 'frontend', to: 'user-store', direction: 'sideways' }] }, /unknown direction/],
    ['an addNodes element that is not an object', { addNodes: ['frontend'] }, /must be an object/],
    ['a removal id that is not a string', { removeNodes: [7] }, /ops\.removeNodes\[0\]/],
  ])('refuses %s, naming the op', (_case, ops, message) => {
    // These all used to pass the top-level shape check, reach the store, and
    // write a file the parser then refused — reported to the caller as success.
    expect(() => applyEdit(BASE, ops as never)).toThrow(EditError)
    expect(() => applyEdit(BASE, ops as never)).toThrow(message)
  })
})
