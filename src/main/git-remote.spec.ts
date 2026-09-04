import { describe, expect, it } from 'vitest'
import { remoteTrouble } from './git-remote'

describe('remoteTrouble', () => {
  // reason: this is what GIT_TERMINAL_PROMPT=0 turns an HTTPS credential
  // prompt into, and pasting it at the user tells them what git could not do
  // rather than what they can.
  it('recognises an HTTPS credential it does not have', () => {
    const said = "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    expect(remoteTrouble(said)?.kind).toBe('https')
    expect(remoteTrouble(said)?.say).toContain('HTTPS credential')
  })

  // reason: BatchMode=yes turns a passphrase prompt into this, and the remedy
  // is the ssh agent rather than anything in this app.
  it('recognises a key the agent is not holding', () => {
    const said = 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'
    expect(remoteTrouble(said)?.kind).toBe('publickey')
    expect(remoteTrouble(said)?.say).toContain('SSH key')
  })

  it('recognises a host that is not in known_hosts', () => {
    expect(remoteTrouble('Host key verification failed.')?.kind).toBe('hostkey')
  })

  // reason: a cached credential that has been revoked or has expired fails
  // differently from one that was never there, and the remedies differ too.
  it('recognises a credential the remote rejected', () => {
    const said = "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'"
    expect(remoteTrouble(said)?.kind).toBe('rejected')
  })

  // reason: the commonest push failure there is — the first push of every
  // branch anyone creates — and the one with a one-button answer.
  it('recognises a branch with nowhere to push to', () => {
    const said = 'fatal: The current branch feat/x has no upstream branch.\nTo push the current branch...'
    expect(remoteTrouble(said)?.kind).toBe('no-upstream')
  })

  it('recognises the other wording git uses for the same thing', () => {
    expect(remoteTrouble('fatal: no upstream configured for branch \'feat/x\'')?.kind).toBe('no-upstream')
  })

  // reason: a rejected non-fast-forward is a real failure with no button on
  // it — the answer is to pull, which the panel already offers — so it must
  // not be dressed up as a credential problem.
  it('says nothing about a failure it does not know', () => {
    expect(remoteTrouble('! [rejected] main -> main (fetch first)')).toBeUndefined()
    expect(remoteTrouble('')).toBeUndefined()
  })

  // reason: git wraps and capitalises differently across versions, and a
  // table that only matched one casing would go quiet after an upgrade.
  it('reads what git said whatever case it said it in', () => {
    expect(remoteTrouble('FATAL: COULD NOT READ USERNAME FOR X')?.kind).toBe('https')
  })
})
