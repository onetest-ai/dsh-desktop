import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findEntity, readBoard } from './board-read'

let project = ''
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dsh-board-'))
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Write one entity file into the board.
 * @param folderPath - the folder within the board.
 * @param kind - which `<kind>.yaml` to write.
 * @param body - the YAML body.
 */
function put(folderPath: string, kind: string, body: string): void {
  const dir = join(project, '.dsh', 'tasks', folderPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${kind}.yaml`), body)
}

describe('readBoard', () => {
  it('reports a project with no board rather than failing', () => {
    const board = readBoard(project)
    expect(board.present).toBe(false)
    expect(board.campaigns).toEqual([])
    expect(board.findings).toEqual([])
  })

  it('reads a campaign, its mission, and its task', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\nstatus: executing\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\nstatus: draft\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\nstatus: done\n')
    const board = readBoard(project)
    expect(board.present).toBe(true)
    expect(board.campaigns).toHaveLength(1)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].children[0].name).toBe('M1')
    expect(board.campaigns[0].children[0].children[0].status).toBe('done')
  })

  it('reads a bug under a campaign and a bug under a mission', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/bugs/b1', 'bug', 'name: B1\nseverity: blocker\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\n')
    put('campaigns/q3/missions/m1/bugs/b2', 'bug', 'name: B2\n')
    const board = readBoard(project)
    const kinds = board.campaigns[0].children.map((child) => `${child.kind}:${child.name}`)
    expect(kinds).toContain('bug:B1')
    expect(kinds).toContain('mission:M1')
    const mission = board.campaigns[0].children.find((child) => child.kind === 'mission')
    expect(mission?.children.map((child) => child.name)).toEqual(['B2'])
  })

  // reason: children are folder-derived, so a folder with no entity file in it
  // is not an entity — and must not become an empty one with a slug for a name.
  it('skips a folder that holds no entity file', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'missions', 'empty'), { recursive: true })
    expect(readBoard(project).campaigns[0].children).toEqual([])
  })

  // reason: reading never writes and never repairs. A file that will not parse
  // is a finding naming it, and an entity that is simply absent.
  it('reports a file it cannot parse and leaves it out', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: [unclosed\n')
    const board = readBoard(project)
    expect(board.campaigns[0].children).toEqual([])
    expect(board.findings).toHaveLength(1)
    expect(board.findings[0].folderPath).toBe('campaigns/q3/missions/m1')
  })

  // reason: a board whose columns are whatever anyone typed is not a board.
  it('reports a status that is not one of the six', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\nstatus: inprogress\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('inprogress'))).toBe(true)
  })

  // reason: a task with no checkable definition of done cannot be gated, and
  // gating is the point. Reported, never refused.
  it('reports a task with no acceptance criteria, and still reads it', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('acceptance criterion'))).toBe(true)
    expect(board.campaigns[0].children[0].children).toHaveLength(1)
  })

  // reason: progress is computed and shown; it is never written. This is the
  // rule the whole design is defined against.
  it('counts progress without touching any status', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\nstatus: draft\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\nstatus: draft\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\nstatus: done\n')
    put('campaigns/q3/missions/m1/tasks/t2', 'task', 'name: T2\nstatus: draft\n')
    const board = readBoard(project)
    const mission = board.campaigns[0].children[0]
    expect(mission.progress).toEqual({ done: 1, total: 2 })
    // The mission's own status is what its file says, whatever its children do.
    expect(mission.status).toBe('draft')
    expect(board.campaigns[0].status).toBe('draft')
  })

  it('never reads the trash', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('.trash/campaigns/gone', 'campaign', 'name: Gone\n')
    expect(readBoard(project).campaigns.map((c) => c.name)).toEqual(['Q3'])
  })

  it('sorts by slug so two reads of one board agree', () => {
    put('campaigns/b', 'campaign', 'name: B\n')
    put('campaigns/a', 'campaign', 'name: A\n')
    expect(readBoard(project).campaigns.map((c) => c.slug)).toEqual(['a', 'b'])
  })
})

describe('findEntity', () => {
  it('finds an entity anywhere in the tree by its folder path', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\n')
    const board = readBoard(project)
    expect(findEntity(board, 'campaigns/q3/missions/m1/tasks/t1')?.name).toBe('T1')
    expect(findEntity(board, 'campaigns/nope')).toBeUndefined()
  })
})
