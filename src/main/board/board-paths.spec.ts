import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardRoot, folderFor, hasBoard, resolveInBoard } from './board-paths'

let project = ''
beforeEach(() => {
  // realpath'd so the fixture's own path is already canonical — on macOS
  // tmpdir() sits under a symlink (/var -> /private/var), and resolveInBoard
  // resolves through realpath too, so an un-normalized fixture path would
  // never equal what it returns even for a folder with no escape involved.
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-')))
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

describe('boardRoot', () => {
  it('puts the board beside the project mcp.json', () => {
    expect(boardRoot('/p')).toBe(join('/p', '.dsh', 'tasks'))
  })
})

describe('hasBoard', () => {
  // reason: a project with no board is a state the panel words, not one this
  // repairs — creating a directory in someone's repository because they opened
  // a view is not a thing to do unasked.
  it('is false for a project that has no board, and creates nothing', () => {
    expect(hasBoard(project)).toBe(false)
    expect(hasBoard(project)).toBe(false)
  })

  it('is true once the directory exists', () => {
    mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
    expect(hasBoard(project)).toBe(true)
  })
})

describe('folderFor', () => {
  it('nests a task under its mission and campaign', () => {
    expect(folderFor('task', ['q3', 'm1', 't1'])).toBe('campaigns/q3/missions/m1/tasks/t1')
  })

  it('nests a bug under a campaign when that is its only parent', () => {
    expect(folderFor('bug', ['q3', 'b1'])).toBe('campaigns/q3/bugs/b1')
  })

  it('nests a bug under a mission when it has one', () => {
    expect(folderFor('bug', ['q3', 'm1', 'b1'])).toBe('campaigns/q3/missions/m1/bugs/b1')
  })

  it('names a campaign and a mission', () => {
    expect(folderFor('campaign', ['q3'])).toBe('campaigns/q3')
    expect(folderFor('mission', ['q3', 'm1'])).toBe('campaigns/q3/missions/m1')
  })
})

describe('resolveInBoard', () => {
  beforeEach(() => {
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3'), { recursive: true })
  })

  it('resolves a folder inside the board', () => {
    expect(resolveInBoard(project, 'campaigns/q3')).toBe(join(project, '.dsh', 'tasks', 'campaigns', 'q3'))
  })

  // reason: this is the boundary. A folder path arrives from the agent and
  // becomes a directory this app writes into and deletes from.
  it('refuses a path that climbs out of the board', () => {
    expect(resolveInBoard(project, '../../../etc')).toBeUndefined()
    expect(resolveInBoard(project, 'campaigns/../../..')).toBeUndefined()
  })

  it('refuses an absolute path', () => {
    expect(resolveInBoard(project, '/etc/passwd')).toBeUndefined()
  })

  // reason: a symlink inside the board pointing out of it escapes a check that
  // only compares strings, so the check resolves the real path of what exists.
  it('refuses a path whose real location is outside the board', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    symlinkSync(outside, join(project, '.dsh', 'tasks', 'campaigns', 'escape'))
    expect(resolveInBoard(project, 'campaigns/escape')).toBeUndefined()
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses the trash, which is not a place to act on entities', () => {
    expect(resolveInBoard(project, '.trash/campaigns/q3')).toBeUndefined()
  })
})
