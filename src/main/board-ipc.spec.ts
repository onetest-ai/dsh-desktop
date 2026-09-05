import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardFor, watchBoard } from './board-ipc'

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

/**
 * Wait for the watcher to say something, or fail rather than hang.
 *
 * A watcher test that passes without a watcher is worse than no test at all,
 * so this rejects when nothing arrives: the assertion is that something was
 * heard, and it can only be made by waiting for it.
 * A watch is not listening the moment it is armed: on macOS a recursive one
 * is an FSEvents stream that takes a moment to start, and a write racing it is
 * a write nobody hears. So the act is delayed rather than the assertion
 * loosened — a test that tolerated hearing nothing would be the vacuous one.
 * @param arm - starts watching, given the callback to fire; returns its stopper.
 * @param act - what to do to the filesystem once the watch is up.
 * @returns how many times the watcher fired, once it has fired at least once.
 */
async function heard(arm: (changed: () => void) => () => void, act: () => void): Promise<number> {
  let fired = 0
  let announce: (() => void) | undefined
  const stop = arm(() => {
    fired += 1
    announce?.()
  })
  try {
    await new Promise((settle) => setTimeout(settle, 400))
    // Whatever the stream replayed as it opened is thrown away: FSEvents hands
    // a new watch the recent history of the directory it was opened on, and
    // the count is only evidence of the act if it starts after the watch is
    // live. The wait for `said` below is what makes it evidence at all.
    fired = 0
    const said = new Promise<void>((resolve, reject) => {
      announce = resolve
      const giveUp = setTimeout(() => reject(new Error('nothing said the board moved')), 3000)
      giveUp.unref?.()
    })
    act()
    await said
  } finally {
    stop()
  }
  return fired
}

describe('watchBoard', () => {
  it('reports a write under an existing board', async () => {
    const fired = await heard(
      (changed) => watchBoard(project, changed),
      () => put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: campaign\n'),
    )
    expect(fired).toBeGreaterThan(0)
  })

  // reason: "ask the agent to plan something and watch it show up" is the path
  // this whole feature exists for, and it starts on a project with no board.
  // Watched for nothing, such a project would never learn one appeared.
  it('reports a board created after watching started', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-late-')))
    try {
      const fired = await heard(
        (changed) => watchBoard(bare, changed),
        () => {
          mkdirSync(join(bare, '.dsh', 'tasks', 'campaigns', 'q3'), { recursive: true })
          writeFileSync(join(bare, '.dsh', 'tasks', 'campaigns', 'q3', 'workitem.yaml'), 'name: Q3\n')
        },
      )
      expect(fired).toBeGreaterThan(0)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  // reason: the ladder waits for the board, it does not build one — the same
  // rule `boardFor` keeps, and main arms this watch for every project opened.
  it('creates nothing for a project with no board', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-unwatched-')))
    const stop = watchBoard(bare, () => {})
    expect(existsSync(join(bare, '.dsh'))).toBe(false)
    stop()
    rmSync(bare, { recursive: true, force: true })
  })

  it('watches nothing when no project is open', () => {
    expect(() => watchBoard(undefined, () => {})()).not.toThrow()
  })
})
