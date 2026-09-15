import { describe, expect, it } from 'vitest'
import { DiagramParseError, parseDiagram, serializeDiagram, type Diagram } from './diagram.ts'

const FULL: Diagram = {
  title: 'Payments',
  nodes: [
    {
      id: 'paypal',
      name: 'PayPal',
      type: 'System',
      icon: 'paypal',
      status: 'live',
      description: 'Receives invoice payments — für alles. 支払い.',
      childDiagram: 'paypal-internals',
      parent: undefined,
      x: 700,
      y: 650,
      w: 220,
      h: 110,
      pinned: true,
    },
  ],
  edges: [
    {
      id: 'e-12',
      from: 'liz',
      to: 'gmail',
      label: 'Liz attaches PDF invoice to email',
      sublabel: 'Implied',
      direction: 'outgoing',
      sourceHandle: 'r1',
      targetHandle: 'l1',
      waypoints: [[420, 300]],
    },
  ],
}

describe('round trip', () => {
  it('survives a full diagram unchanged', () => {
    expect(parseDiagram(serializeDiagram(FULL))).toEqual(FULL)
  })

  it('is byte-stable across two serializations', () => {
    const once = serializeDiagram(FULL)
    expect(serializeDiagram(parseDiagram(once))).toBe(once)
  })

  it('keeps prose and unicode in labels intact', () => {
    const back = parseDiagram(serializeDiagram(FULL))
    expect(back.nodes[0]?.description).toBe('Receives invoice payments — für alles. 支払い.')
  })

  it('accepts a node with no coordinates yet', () => {
    const pending = parseDiagram('{"title":"T","nodes":[{"id":"a","name":"A","type":"System","w":200,"h":100,"pinned":false}],"edges":[]}')
    expect(pending.nodes[0]?.x).toBeUndefined()
    expect(pending.nodes[0]?.pinned).toBe(false)
  })
})

describe('parseDiagram', () => {
  it.each([
    ['malformed JSON', '{ not json'],
    ['a missing title', '{"nodes":[],"edges":[]}'],
    ['nodes that are not an array', '{"title":"T","nodes":{},"edges":[]}'],
    ['a node with no id', '{"title":"T","nodes":[{"name":"A","type":"S","w":1,"h":1,"pinned":false}],"edges":[]}'],
    ['an unknown edge direction', '{"title":"T","nodes":[],"edges":[{"id":"e","from":"a","to":"b","direction":"sideways"}]}'],
    ['a string "pinned" on a node', '{"title":"T","nodes":[{"id":"a","name":"A","type":"S","w":1,"h":1,"pinned":"true"}],"edges":[]}'],
    ['a numeric "pinned" on a node', '{"title":"T","nodes":[{"id":"a","name":"A","type":"S","w":1,"h":1,"pinned":1}],"edges":[]}'],
    ['a string "x" on a node', '{"title":"T","nodes":[{"id":"a","name":"A","type":"S","w":1,"h":1,"pinned":false,"x":"700"}],"edges":[]}'],
    ['a node with "x" but no "y"', '{"title":"T","nodes":[{"id":"a","name":"A","type":"S","w":1,"h":1,"pinned":false,"x":700}],"edges":[]}'],
    ['a node with "y" but no "x"', '{"title":"T","nodes":[{"id":"a","name":"A","type":"S","w":1,"h":1,"pinned":false,"y":650}],"edges":[]}'],
    ['non-numeric waypoint elements', '{"title":"T","nodes":[],"edges":[{"id":"e","from":"a","to":"b","direction":"none","waypoints":["a",1]}]}'],
    ['a short waypoint tuple', '{"title":"T","nodes":[],"edges":[{"id":"e","from":"a","to":"b","direction":"none","waypoints":[[1,2],[3]]}]}'],
    ['a waypoint with a non-numeric coordinate', '{"title":"T","nodes":[],"edges":[{"id":"e","from":"a","to":"b","direction":"none","waypoints":[[1,"2"]]}]}'],
  ])('rejects %s', (_case, text) => {
    expect(() => parseDiagram(text)).toThrow(DiagramParseError)
  })

  it('names the problem in the message', () => {
    expect(() => parseDiagram('{"nodes":[],"edges":[]}')).toThrow(/title/)
  })

  it('reports a present-but-empty id distinctly from an absent one', () => {
    expect(() => parseDiagram('{"title":"T","nodes":[{"id":"","name":"A","type":"S","w":1,"h":1,"pinned":false}],"edges":[]}')).toThrow(/must not be empty/)
    expect(() => parseDiagram('{"title":"T","nodes":[{"name":"A","type":"S","w":1,"h":1,"pinned":false}],"edges":[]}')).toThrow(/missing/)
  })

  it('defaults a node with no pinned key to pinned: false', () => {
    const parsed = parseDiagram('{"title":"T","nodes":[{"id":"a","name":"A","type":"System","w":200,"h":100}],"edges":[]}')
    expect(parsed.nodes[0]?.pinned).toBe(false)
  })

  it('still accepts a node with no coordinates', () => {
    const pending = parseDiagram('{"title":"T","nodes":[{"id":"a","name":"A","type":"System","w":200,"h":100,"pinned":false}],"edges":[]}')
    expect(pending.nodes[0]?.x).toBeUndefined()
    expect(pending.nodes[0]?.y).toBeUndefined()
  })
})
