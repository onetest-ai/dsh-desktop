import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { projectMcpPath, readWorkspaces, workspacesPath } from './workspaces'

/** A fresh `$DSH_HOME` with the given `workspace.json` text, or none at all. */
function home(storage?: string): string {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-workspaces-'))
  if (storage !== undefined) {
    mkdirSync(join(dshHome, 'storages'), { recursive: true })
    writeFileSync(workspacesPath(dshHome), storage)
  }
  return dshHome
}

/** A workspace storage file declaring the given records. */
function storageWith(workspaces: Record<string, unknown>): string {
  return JSON.stringify({ unit: { name: 'workspace', version: 2 }, tables: { workspaces } })
}

/** A fresh project directory, optionally with an `.dsh/mcp.json` in it. */
function project(mcpJson?: string): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-project-'))
  if (mcpJson !== undefined) {
    const file = projectMcpPath(path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, mcpJson)
  }
  return path
}

describe('readWorkspaces', () => {
  it('reports each project with the servers its own mcp.json declares', () => {
    const path = project('{ "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp"] } } }')
    const dshHome = home(storageWith({ a: { path, title: 'demo', updatedAt: '2026-08-27T00:00:00.000Z' } }))
    expect(readWorkspaces(dshHome)).toEqual([
      {
        path,
        title: 'demo',
        file: projectMcpPath(path),
        declared: true,
        servers: [expect.objectContaining({ name: 'playwright', transport: 'stdio', command: 'npx' })],
      },
    ])
  })

  // reason: the harness records no current workspace, so the list itself has
  // to put the one the user is working in first.
  it('orders the most recently used project first', () => {
    const dshHome = home(
      storageWith({
        old: { path: project(), title: 'old', updatedAt: '2026-08-01T00:00:00.000Z' },
        recent: { path: project(), title: 'recent', updatedAt: '2026-08-27T00:00:00.000Z' },
        middle: { path: project(), title: 'middle', updatedAt: '2026-08-15T00:00:00.000Z' },
      }),
    )
    expect(readWorkspaces(dshHome).map((each) => each.title)).toEqual(['recent', 'middle', 'old'])
  })

  it('reports a project that declares nothing, rather than hiding it', () => {
    const path = project()
    const dshHome = home(storageWith({ a: { path, title: 'bare', updatedAt: '' } }))
    expect(readWorkspaces(dshHome)).toEqual([
      { path, title: 'bare', file: projectMcpPath(path), declared: false, servers: [] },
    ])
  })

  it('falls back to the directory when a record carries no title', () => {
    const path = project()
    const dshHome = home(storageWith({ a: { path } }))
    expect(readWorkspaces(dshHome)[0].title).toBe(path)
  })

  // reason: this is someone else's file. Every one of these shapes has to read
  // as "no workspaces" rather than throwing into the Settings window's read.
  it.each([
    ['no storage file at all', undefined],
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['no tables', '{}'],
    ['a tables member that is not an object', '{ "tables": 7 }'],
    ['no workspaces table', '{ "tables": {} }'],
    ['a workspaces table that is not an object', '{ "tables": { "workspaces": [] } }'],
  ])('reads %s as no workspaces', (_case, storage) => {
    expect(readWorkspaces(home(storage))).toEqual([])
  })

  it('skips a record with no usable path and keeps the rest', () => {
    const path = project()
    const dshHome = home(
      storageWith({ bad: { title: 'no path' }, empty: { path: '' }, notObject: 7, good: { path, title: 'good' } }),
    )
    expect(readWorkspaces(dshHome).map((each) => each.title)).toEqual(['good'])
  })
})
