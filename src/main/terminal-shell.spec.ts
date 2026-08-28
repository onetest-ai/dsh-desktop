import { describe, expect, it } from 'vitest'
import { FALLBACK_SHELL, argsFor, resolveShell, shellProblem } from './terminal-shell'

describe('resolveShell', () => {
  it('prefers the configured shell over the login shell', () => {
    expect(resolveShell('/opt/homebrew/bin/fish', { SHELL: '/bin/zsh' })).toEqual({
      command: '/opt/homebrew/bin/fish',
      args: ['--interactive'],
      source: 'configured',
    })
  })

  it('uses the login shell when none is configured', () => {
    expect(resolveShell(undefined, { SHELL: '/bin/bash' })).toEqual({
      command: '/bin/bash',
      args: ['-i'],
      source: 'environment',
    })
  })

  // reason: an app launched from Finder inherits almost nothing, and a
  // terminal that cannot start at all is worse than one running the platform
  // default.
  it('falls back when the environment names no shell', () => {
    expect(resolveShell(undefined, {})).toMatchObject({ command: FALLBACK_SHELL, source: 'fallback' })
    expect(resolveShell(undefined, { SHELL: '' })).toMatchObject({ source: 'fallback' })
  })

  // reason: a settings field someone cleared should behave as unset, not as a
  // request to run the empty string.
  it('treats a blank configured shell as unset', () => {
    expect(resolveShell('   ', { SHELL: '/bin/bash' })).toMatchObject({
      command: '/bin/bash',
      source: 'environment',
    })
  })

  it('trims a path that was pasted with whitespace', () => {
    expect(resolveShell(' /bin/bash ', {})).toMatchObject({ command: '/bin/bash' })
  })
})

describe('argsFor', () => {
  // reason: fish rejects `-i`; it spells the same thing `--interactive`.
  it('gives fish its own spelling of interactive', () => {
    expect(argsFor('/opt/homebrew/bin/fish')).toEqual(['--interactive'])
    expect(argsFor('/bin/zsh')).toEqual(['-i'])
    expect(argsFor('/bin/bash')).toEqual(['-i'])
  })
})

describe('shellProblem', () => {
  it('accepts an executable absolute path', () => {
    expect(shellProblem('/bin/zsh', () => true)).toBeUndefined()
  })

  // reason: the message has to name the setting, or the user meets
  // `posix_spawnp failed` from inside the pty and has nothing to act on.
  it('reports a path that is not executable', () => {
    expect(shellProblem('/bin/nope', () => false)).toContain('not an executable file')
  })

  it('reports a bare name, which the pty would not resolve', () => {
    const problem = shellProblem('bash', () => true)
    expect(problem).toContain('not an absolute path')
    expect(problem).toContain('/bin/bash')
  })
})
