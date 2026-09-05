import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardFor } from './board-ipc'

let project = ''
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-ipc-')))
  mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Write one board file.
 * @param path - the path within `.dsh/tasks/`.
 * @param body - the YAML body.
 */
function put(path: string, body: string): void {
  const full = join(project, '.dsh', 'tasks', path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

describe('boardFor', () => {
  it('reports no board when no project is open', () => {
    expect(boardFor(undefined)).toEqual({ present: false, campaigns: [], tests: { path: 'tests', slug: 'tests', suites: [], tests: [] }, findings: [] })
  })

  it('carries a campaign, its mission and its task', () => {
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: campaign\nstatus: executing\n')
    put('campaigns/q3/missions/m1/workitem.yaml', 'name: M1\nsubtype: mission\n')
    put('campaigns/q3/missions/m1/tasks/t1/workitem.yaml', 'name: T1\nsubtype: task\nstatus: done\nacceptance_criteria:\n  - text: it works\n    done: true\n')
    const board = boardFor(project)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].children[0].children[0].status).toBe('done')
  })

  // reason: the wire shape is what both views draw from, and it must carry
  // only what they draw — a whole `EntityFields` would put every criterion's
  // prose across the bridge on every keystroke-triggered redraw.
  it('carries counts rather than the fields they were counted from', () => {
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: campaign\n')
    put(
      'campaigns/q3/missions/m1/workitem.yaml',
      'name: M1\nsubtype: mission\nacceptance_criteria:\n  - text: a\n    done: true\n  - text: b\n    done: false\n',
    )
    const mission = boardFor(project).campaigns[0].children[0]
    expect(mission.criteria).toEqual({ done: 1, total: 2 })
    expect(mission).not.toHaveProperty('fields')
  })

  it('counts the verdicts on a workitem', () => {
    put('tests/login/test.yaml', 'name: Login\n')
    put('tests/logout/test.yaml', 'name: Logout\n')
    put(
      'campaigns/q3/workitem.yaml',
      'name: Q3\nsubtype: campaign\nvalidated_by:\n  - test: tests/login\n    result: pass\n  - test: tests/logout\n    result: fail\n    bug: campaigns/q3/bugs/b\n',
    )
    put('campaigns/q3/bugs/b/bug.yaml', 'name: B\n')
    expect(boardFor(project).campaigns[0].verdicts).toEqual({ pass: 1, total: 2 })
  })

  // reason: the tree shows the reverse direction — what a test validates —
  // and it is the only place that direction is visible.
  it('carries what each test validates, and how much of it passes', () => {
    put('tests/login/test.yaml', 'name: Login\n')
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: campaign\nvalidated_by:\n  - test: tests/login\n    result: pass\n')
    const test = boardFor(project).tests.tests[0]
    expect(test.name).toBe('Login')
    expect(test.validates).toEqual({ pass: 1, total: 1 })
  })

  it('carries nested suites', () => {
    put('tests/auth/oauth/login/test.yaml', 'name: Login\n')
    const tests = boardFor(project).tests
    expect(tests.suites[0].slug).toBe('auth')
    expect(tests.suites[0].suites[0].tests[0].name).toBe('Login')
  })

  it('carries the findings the store reported', () => {
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: mission\n')
    expect(boardFor(project).findings.some((finding) => finding.says.includes('subtype'))).toBe(true)
  })

  // reason: reading a board must never create one — the same rule the store
  // keeps, and the views call this on every focus.
  it('creates nothing for a project with no board', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-bare-')))
    expect(boardFor(bare).present).toBe(false)
    expect(boardFor(bare).present).toBe(false)
    rmSync(bare, { recursive: true, force: true })
  })
})
