import { describe, expect, it } from 'vitest'
import { placeNewNodes } from './placement'
import type { ArchNode, Diagram } from './diagram'

/**
 * @param id - the node id.
 * @param extra - fields overriding the defaults.
 * @returns a node with sane defaults.
 */
function node(id: string, extra: Partial<ArchNode> = {}): ArchNode {
  return { id, name: id, type: 'System', w: 200, h: 100, pinned: false, ...extra }
}

/**
 * @param nodes - the nodes.
 * @param edges - `[from, to]` pairs.
 * @returns a diagram.
 */
function diagram(nodes: ArchNode[], edges: Array<[string, string]> = []): Diagram {
  return {
    title: 'T',
    nodes,
    edges: edges.map(([from, to], index) => ({ id: `e${String(index)}`, from, to, direction: 'outgoing' as const })),
  }
}

describe('placeNewNodes', () => {
  it('gives every node coordinates', () => {
    const out = placeNewNodes(diagram([node('a'), node('b')]))
    for (const placed of out.nodes) {
      expect(typeof placed.x).toBe('number')
      expect(typeof placed.y).toBe('number')
    }
  })

  it('places a new node near its connected neighbour', () => {
    const out = placeNewNodes(diagram([node('anchor', { x: 1000, y: 1000, pinned: true }), node('fresh')], [['anchor', 'fresh']]))
    const fresh = out.nodes.find((n) => n.id === 'fresh')
    expect(Math.abs((fresh?.x ?? 0) - 1000)).toBeLessThan(800)
    expect(Math.abs((fresh?.y ?? 0) - 1000)).toBeLessThan(800)
  })

  it('places a new node between two neighbours it connects', () => {
    const out = placeNewNodes(
      diagram(
        [node('left', { x: 0, y: 500, pinned: true }), node('right', { x: 1000, y: 500, pinned: true }), node('mid')],
        [['left', 'mid'], ['mid', 'right']],
      ),
    )
    const mid = out.nodes.find((n) => n.id === 'mid')
    expect(mid?.x).toBeGreaterThan(0)
    expect(mid?.x).toBeLessThan(1000)
  })

  it('overlaps nothing', () => {
    const out = placeNewNodes(diagram([node('a', { x: 0, y: 0, pinned: true }), node('b'), node('c'), node('d')]))
    for (const one of out.nodes) {
      for (const other of out.nodes) {
        if (one.id === other.id) continue
        const apart =
          (one.x ?? 0) + one.w <= (other.x ?? 0) ||
          (other.x ?? 0) + other.w <= (one.x ?? 0) ||
          (one.y ?? 0) + one.h <= (other.y ?? 0) ||
          (other.y ?? 0) + other.h <= (one.y ?? 0)
        expect(apart).toBe(true)
      }
    }
  })

  it('is deterministic', () => {
    const input = diagram([node('a', { x: 0, y: 0, pinned: true }), node('b'), node('c')], [['a', 'b']])
    expect(placeNewNodes(input)).toEqual(placeNewNodes(input))
  })
})

describe('the pin invariant', () => {
  const PINNED = node('pin', { x: 321, y: 654, pinned: true })

  it.each([
    ['a new unconnected node arrives', diagram([PINNED, node('new')])],
    ['a new connected node arrives', diagram([PINNED, node('new')], [['pin', 'new']])],
    ['many new nodes arrive', diagram([PINNED, node('n1'), node('n2'), node('n3'), node('n4')])],
    ['it is the only node', diagram([PINNED])],
    ['placement runs twice', diagram([PINNED, node('new')])],
  ])('leaves a pinned node exactly where it is when %s', (_case, input) => {
    const once = placeNewNodes(input)
    const twice = placeNewNodes(once)
    for (const out of [once, twice]) {
      const pinned = out.nodes.find((n) => n.id === 'pin')
      expect(pinned?.x).toBe(321)
      expect(pinned?.y).toBe(654)
      expect(pinned?.pinned).toBe(true)
    }
  })

  it('leaves an unpinned node that already has coordinates alone', () => {
    const cached = node('cached', { x: 42, y: 84, pinned: false })
    const out = placeNewNodes(diagram([cached, node('new')]))
    const back = out.nodes.find((n) => n.id === 'cached')
    expect(back?.x).toBe(42)
    expect(back?.y).toBe(84)
  })
})
