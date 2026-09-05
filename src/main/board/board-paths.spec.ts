import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardRoot, fileFor, folderFor, hasBoard, resolveInBoard } from './board-paths'

let project = ''
beforeEach(() => {
  // Not realpath'd. resolveInBoard resolves the target and the board root the
  // same way — through the nearest existing ancestor — so a fixture path that
  // is itself un-normalized (tmpdir() sits under a symlink on macOS, /var ->
  // /private/var) still agrees with what resolveInBoard returns. Leaving this
  // un-hoisted is what proves that: it used to be the only thing hiding the
  // asymmetry between a realpath'd root and a lexical target.
  project = mkdtempSync(join(tmpdir(), 'dsh-board-'))
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

describe('fileFor', () => {
  // reason: the file is named for the TYPE while the directory says the
  // LEVEL. A reader that looked for `mission.yaml` would find nothing.
  it('names the file after the type, not the level', () => {
    expect(fileFor('campaign')).toBe('workitem.yaml')
    expect(fileFor('mission')).toBe('workitem.yaml')
    expect(fileFor('task')).toBe('workitem.yaml')
    expect(fileFor('bug')).toBe('bug.yaml')
    expect(fileFor('test')).toBe('test.yaml')
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

  // reason: tests are their own container, and a suite is just a directory —
  // so a test's path is its suites and its slug, at any depth.
  it('puts a test under the tests root, at whatever depth its suites give it', () => {
    expect(folderFor('test', ['login'])).toBe('tests/login')
    expect(folderFor('test', ['auth', 'login'])).toBe('tests/auth/login')
    expect(folderFor('test', ['auth', 'oauth', 'google', 'callback'])).toBe('tests/auth/oauth/google/callback')
  })
})

describe('resolveInBoard', () => {
  beforeEach(() => {
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3'), { recursive: true })
  })

  // reason: the return value is realpath'd, so what it is compared against
  // has to be too — a project root that is not itself canonical (an ordinary
  // /tmp checkout on macOS included) must not make an unremarkable folder
  // fail this the way an escaping symlink correctly does.
  it('resolves a folder inside the board', () => {
    expect(resolveInBoard(project, 'campaigns/q3')).toBe(realpathSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3')))
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

  // reason: this proves the escape is refused, which only means something
  // against a canonical root. Against the suite's un-hoisted, possibly
  // non-canonical `project`, the pre-fix code (which compared a lexical
  // target against a realpathed root) refused this path too — but for the
  // wrong reason, since it refused every not-yet-existing path regardless of
  // where it led. Realpathing this fixture's own root at setup is what makes
  // a failure here mean the symlink walk was skipped, not that the root
  // happened to disagree with itself.
  it('refuses a not-yet-existing target under a symlinked container', () => {
    const canonicalProject = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-canon-')))
    mkdirSync(join(canonicalProject, '.dsh', 'tasks', 'campaigns', 'q3'), { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    symlinkSync(outside, join(canonicalProject, '.dsh', 'tasks', 'campaigns', 'escaped'))
    expect(resolveInBoard(canonicalProject, 'campaigns/escaped/pwned')).toBeUndefined()
    rmSync(outside, { recursive: true, force: true })
    rmSync(canonicalProject, { recursive: true, force: true })
  })

  // reason: same property as above, one layer deeper — the escaping symlink
  // can sit several directories above the target, not only immediately above
  // it (a mission and its task, both still to be created, under a campaign
  // whose `missions/` is a symlink) — so realpathing just the immediate
  // parent would miss it. Needs the same canonical root for the same reason:
  // against a non-canonical one, the pre-fix code refuses this path too, but
  // because it refuses every not-yet-existing path, not because it caught the
  // symlink.
  it('refuses a not-yet-existing target several levels under a symlinked container', () => {
    const canonicalProject = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-canon-')))
    mkdirSync(join(canonicalProject, '.dsh', 'tasks', 'campaigns', 'q3'), { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    symlinkSync(outside, join(canonicalProject, '.dsh', 'tasks', 'campaigns', 'q3', 'missions'))
    expect(resolveInBoard(canonicalProject, 'campaigns/q3/missions/m1/tasks/t1')).toBeUndefined()
    rmSync(outside, { recursive: true, force: true })
    rmSync(canonicalProject, { recursive: true, force: true })
  })
})
