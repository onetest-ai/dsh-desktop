import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  it.each([['a traversal', '../escape'], ['an absolute path', '/etc/passwd'], ['an empty id', '']])(
    'refuses %s',
    (_case, id) => {
      expect(() => createDiagram(project, id, 'X')).toThrow(StoreError)
    },
  )
})

describe('readDiagram', () => {
  it('reports a missing diagram distinctly from a corrupt one', () => {
    expect(() => readDiagram(project, 'nope')).toThrow(/not found/)
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), 'broken.json'), '{ not json')
    expect(() => readDiagram(project, 'broken')).toThrow(/broken\.json/)
  })
})

describe('listDiagrams', () => {
  it('returns nothing for a project with no arch directory', () => {
    expect(listDiagrams(project)).toEqual([])
  })

  it('never creates the arch directory just by looking', () => {
    listDiagrams(project)
    expect(() => readFileSync(archRoot(project))).toThrow()
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
})
