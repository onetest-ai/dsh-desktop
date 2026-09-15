import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { archRoot } from './paths.ts'
import { createDiagram, deleteDiagram, listDiagrams, readDiagram, StoreError, writeDiagram } from './store.ts'

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'store-'))
})

describe('createDiagram', () => {
  it('writes a new empty diagram', () => {
    const made = createDiagram(project, 'payments', 'Payments')
    expect(made).toEqual({ title: 'Payments', nodes: [], edges: [] })
    expect(readDiagram(project, 'payments').title).toBe('Payments')
  })

  it('refuses to overwrite an existing diagram', () => {
    createDiagram(project, 'payments', 'Payments')
    expect(() => createDiagram(project, 'payments', 'Again')).toThrow(StoreError)
  })

  it.each([
    ['a traversal', '../escape'],
    ['an absolute path', '/etc/passwd'],
    ['an empty id', ''],
    ['a nested id', 'a/b'],
    ['a dot id', '.'],
    ['a double-dot id', '..'],
    ['a hidden-file id', '.hidden'],
  ])('refuses %s', (_case, id) => {
    expect(() => createDiagram(project, id, 'X')).toThrow(StoreError)
  })

  // A plain id such as 'payments' is already exercised by the "writes a new
  // empty diagram" test above; only the dash/underscore case is new here.
  it('accepts an id with a dash or underscore', () => {
    expect(createDiagram(project, 'user-flows_v2', 'X').title).toBe('X')
  })
})

describe('readDiagram', () => {
  it('reports a missing diagram distinctly from a corrupt one', () => {
    expect(() => readDiagram(project, 'nope')).toThrow(/not found/)
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), 'broken.json'), '{ not json')
    expect(() => readDiagram(project, 'broken')).toThrow(/broken\.json/)
  })

  it('reads a file with a non-conforming name that could not have been created through this module', () => {
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), '.hidden.json'), JSON.stringify({ title: 'Hidden', nodes: [], edges: [] }))
    expect(readDiagram(project, '.hidden').title).toBe('Hidden')
  })
})

describe('listDiagrams', () => {
  it('returns nothing for a project with no arch directory', () => {
    expect(listDiagrams(project)).toEqual([])
  })

  it('never creates the arch directory just by looking', () => {
    listDiagrams(project)
    expect(existsSync(archRoot(project))).toBe(false)
  })

  it('carries a node index so callers need not read every file', () => {
    createDiagram(project, 'auth', 'Auth')
    writeDiagram(project, 'auth', {
      title: 'Auth',
      nodes: [{ id: 'sso', name: 'SSO', type: 'External system: Okta', x: 0, y: 0, w: 200, h: 100, pinned: false }],
      edges: [],
    })
    expect(listDiagrams(project)).toEqual([
      { id: 'auth', title: 'Auth', nodes: [{ id: 'sso', name: 'SSO', type: 'External system: Okta' }] },
    ])
  })

  it('fails one broken file without losing the others', () => {
    createDiagram(project, 'good', 'Good')
    writeFileSync(join(archRoot(project), 'bad.json'), '{ not json')
    const listed = listDiagrams(project)
    expect(listed.find((entry) => entry.id === 'good')?.title).toBe('Good')
    expect(listed.find((entry) => entry.id === 'bad')?.error).toMatch(/JSON/)
  })

  it('is sorted by id, so output is stable', () => {
    createDiagram(project, 'zeta', 'Z')
    createDiagram(project, 'alpha', 'A')
    expect(listDiagrams(project).map((entry) => entry.id)).toEqual(['alpha', 'zeta'])
  })
})

describe('deleteDiagram', () => {
  it('removes it', () => {
    createDiagram(project, 'temp', 'Temp')
    deleteDiagram(project, 'temp')
    expect(listDiagrams(project)).toEqual([])
  })

  it('refuses an unknown diagram', () => {
    expect(() => deleteDiagram(project, 'ghost')).toThrow(StoreError)
  })

  it('removes a file with a non-conforming name that could not have been created through this module', () => {
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), '.hidden.json'), JSON.stringify({ title: 'Hidden', nodes: [], edges: [] }))
    deleteDiagram(project, '.hidden')
    expect(listDiagrams(project)).toEqual([])
  })
})

describe('writeDiagram', () => {
  it('refuses a malformed id, since it can create a file as well as overwrite one', () => {
    const diagram = { title: 'X', nodes: [], edges: [] }
    expect(() => writeDiagram(project, 'a/b', diagram)).toThrow(StoreError)
  })

  it('overwrites a file whose name it could not have created', () => {
    // A `.hidden.json` on disk was listable, readable and deletable but not
    // writable, so the canvas could never save a drag on it — the stem rule
    // applies to MAKING a name, and an overwrite makes none.
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), '.hidden.json'), JSON.stringify({ title: 'Hidden', nodes: [], edges: [] }))
    writeDiagram(project, '.hidden', { title: 'Hidden, moved', nodes: [], edges: [] })
    expect(readDiagram(project, '.hidden').title).toBe('Hidden, moved')
  })

  it('still refuses to CREATE a non-conforming name', () => {
    expect(() => writeDiagram(project, '.hidden', { title: 'X', nodes: [], edges: [] })).toThrow(StoreError)
  })

  it('refuses a diagram the next read would refuse, and leaves the old file intact', () => {
    // The choke point. `applyEdit` used to hand this module a node with no id
    // and it was written, reported ok, and unreadable ever after.
    createDiagram(project, 'auth', 'Auth')
    const corrupt = {
      title: 'Auth',
      nodes: [{ x: 0, y: 0, w: 220, h: 110, pinned: false }],
      edges: [],
    } as unknown as Parameters<typeof writeDiagram>[2]
    expect(() => writeDiagram(project, 'auth', corrupt)).toThrow(/missing "id"/)
    expect(readDiagram(project, 'auth')).toEqual({ title: 'Auth', nodes: [], edges: [] })
  })
})
