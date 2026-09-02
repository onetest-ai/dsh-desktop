import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitEnv, runGit, setGitPath } from './git-run'

/**
 * Whether a git this machine can run exists at all.
 *
 * The tests below spawn a real one — nothing else can show that the
 * environment reaches the child — so on a machine without git they are
 * skipped rather than failed: a missing git says nothing about this code.
 */
const gitInstalled = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('gitEnv', () => {
  // reason: without all four, an unattended git blocks forever on a prompt
  // that has no terminal to appear in, holding the panel on a spinner.
  it('stops git and ssh asking for anything', () => {
    const env = gitEnv({ PATH: '/usr/bin' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes')
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never')
    expect(env.GIT_ASKPASS).toBeUndefined()
  })

  it('keeps the rest of the environment, which is where PATH lives', () => {
    expect(gitEnv({ PATH: '/usr/bin', HOME: '/h' }).PATH).toBe('/usr/bin')
  })

  // reason: an askpass inherited from the user's own shell would reintroduce
  // the GUI prompt the other three variables exist to prevent.
  it('drops an inherited GIT_ASKPASS', () => {
    expect(gitEnv({ GIT_ASKPASS: '/usr/bin/x' }).GIT_ASKPASS).toBeUndefined()
  })

  // reason: a packaged app launched from Finder inherits a PATH that finds
  // either nothing or the wrong git, so the composed one has to replace it.
  it('runs under the PATH it is given, over the inherited one', () => {
    expect(gitEnv({ PATH: '/usr/bin' }, '/opt/homebrew/bin:/usr/bin').PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })
})

describe.skipIf(!gitInstalled)('runGit (spawns a real git; skipped when git is not installed)', () => {
  afterEach(() => {
    setGitPath(() => undefined)
  })

  it('reports what git said, and its exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-run-'))
    expect((await runGit(dir, ['init', '-q'])).code).toBe(0)
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const status = await runGit(dir, ['status', '--porcelain'])
    expect(status.code).toBe(0)
    expect(status.stdout.toString('utf8')).toContain('a.txt')
  })

  // reason: a failure is a result the panel shows, not an exception it has to
  // catch at every call site.
  it('returns a non-zero code rather than throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-run-'))
    const out = await runGit(dir, ['rev-parse', 'HEAD'])
    expect(out.code).not.toBe(0)
    expect(out.stderr).not.toBe('')
  })

  // reason: every other test here passes with `env: process.env`, so none of
  // them shows that the four variables the panel depends on ever reach the
  // process that has to honour them. This asks git itself, through a shell
  // alias, what it was started with.
  it('starts the child in the environment gitEnv composed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-run-'))
    await runGit(dir, ['init', '-q'])
    const out = await runGit(dir, ['-c', 'alias.envcheck=!echo $GIT_TERMINAL_PROMPT', 'envcheck'])
    expect(out.code).toBe(0)
    expect(out.stdout.toString('utf8').trim()).toBe('0')
  })

  // reason: the panel's empty state tells the user to add git's directory
  // under Settings → Advanced → Extra PATH entries. That is only true if the
  // composed PATH is what the child actually searches.
  it('finds its binary on the PATH setGitPath named, not the inherited one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-run-'))
    const real = execFileSync('sh', ['-c', 'command -v git']).toString('utf8').trim()
    // A PATH with git's own directory removed: `git` is then unfindable, and
    // the failure is the evidence that this PATH is the one being searched.
    setGitPath(() => '/nonexistent-for-this-test')
    expect((await runGit(dir, ['--version'])).code).not.toBe(0)
    setGitPath(() => dirname(real))
    expect((await runGit(dir, ['--version'])).code).toBe(0)
  })
})
