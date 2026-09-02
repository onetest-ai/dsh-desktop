import { describe, expect, it } from 'vitest'
import { gitEnv } from './git-run'

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
})

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from './git-run'

describe('runGit', () => {
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
})
