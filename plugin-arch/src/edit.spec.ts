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
})
