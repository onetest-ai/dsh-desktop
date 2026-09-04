import { describe, expect, it } from 'vitest'
import { remote, remoteLine, remoteTrouble, REMOTE_TIMEOUT_MS } from './git-remote'
import type { GitResult } from './git-run'

/**
 * Real `git push` stderr, captured from a non-fast-forward push between two
 * clones of the same bare repository (`git 2.50.1`, macOS). The path is
 * replaced with a placeholder; the wording and shape are git's own.
 *
 * A test built from what this file's author imagined git says is exactly how
 * the bug this guards against got in: hand-authored stderr never carries the
 * `To <url>` narration real git always leads with.
 */
const REAL_PUSH_REJECTED =
  'To /repo/origin.git\n' +
  ' ! [rejected]        HEAD -> main (fetch first)\n' +
  "error: failed to push some refs to '/repo/origin.git'\n" +
  'hint: Updates were rejected because the remote contains work that you do not\n' +
  'hint: have locally. This is usually caused by another repository pushing to\n' +
  'hint: the same ref. If you want to integrate the remote changes, use\n' +
  "hint: 'git pull' before pushing again.\n" +
  "hint: See the 'Note about fast-forwards' in 'git push --help' for details."

/**
 * Real `git pull` stderr, captured from a divergent pull with no
 * `pull.rebase` configured (`git 2.50.1`, macOS, exit code 128). The path is
 * a placeholder; the wording is git's own.
 */
const REAL_PULL_DIVERGED =
  'From /repo/origin\n' +
  ' * branch            main       -> FETCH_HEAD\n' +
  '   94e7b6b..9d030ef  main       -> origin/main\n' +
  'hint: You have divergent branches and need to specify how to reconcile them.\n' +
  'hint: You can do so by running one of the following commands sometime before\n' +
  'hint: your next pull:\n' +
  'hint:\n' +
  'hint:   git config pull.rebase false  # merge\n' +
  'hint:   git config pull.rebase true   # rebase\n' +
  'hint:   git config pull.ff only       # fast-forward only\n' +
  'hint:\n' +
  'hint: You can replace "git config" with "git config --global" to set a default\n' +
  'hint: preference for all repositories. You can also pass --rebase, --no-rebase,\n' +
  'hint: or --ff-only on the command line to override the configured default per\n' +
  'hint: invocation.\n' +
  'fatal: Need to specify how to reconcile divergent branches.'

describe('remoteLine', () => {
  // reason: the panel's own reproduction of the defect this guards — before
  // this, a rejected push reported "To /repo/origin.git", which reads like
  // success rather than the refusal it actually was.
  it('reports the refusal, not the To line, for a real non-fast-forward push', () => {
    expect(remoteLine(REAL_PUSH_REJECTED, '')).toBe("error: failed to push some refs to '/repo/origin.git'")
  })

  // reason: the second reproduction — a real divergent pull reports "From
  // /repo/origin" under the old rule, which is no more a failure than a URL.
  it('reports the refusal, not the From line, for a real divergent pull', () => {
    expect(remoteLine(REAL_PULL_DIVERGED, '')).toBe('fatal: Need to specify how to reconcile divergent branches.')
  })

  // reason: `firstLine`'s own rule — stdout only when stderr is silent, and
  // its own fallback when neither says anything — is still right when there
  // is no narration to skip past.
  it('falls back to firstLine when stderr has nothing to skip', () => {
    expect(remoteLine('', 'nothing to commit')).toBe('nothing to commit')
    expect(remoteLine('', '')).toBe('git failed without saying why.')
  })
})

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

  // reason: a `remote:` line is the server echoing its own words back — a
  // pre-receive hook's own "Authentication failed" over its own token — not
  // this git's transport credential. Matching it would relabel a refusal
  // that has nothing to do with this machine and send the user to Open in
  // Terminal, the wrong remedy for it.
  it('does not mistake the server\'s own echoed words for this git\'s own failure', () => {
    const said = 'remote: Authentication failed, access denied.\nfatal: unable to access the repository'
    expect(remoteTrouble(said)).toBeUndefined()
  })

  // reason: the same wording said by this git, on stderr proper rather than
  // echoed from the server, is still the credential failure it always was.
  it('still recognises the same wording when git says it, not the server', () => {
    const said = "remote: Some server-side note.\nfatal: Authentication failed for 'https://github.com/a/b.git/'"
    expect(remoteTrouble(said)?.kind).toBe('rejected')
  })
})

/**
 * A git that answers from a script, recording what it was asked.
 * @param answers - one answer per call, in order; the last repeats.
 * @returns the double and the calls it recorded.
 */
function fakeGit(answers: Partial<GitResult>[]): {
  run: (cwd: string, args: string[], gitPath?: string, opts?: unknown) => Promise<GitResult>
  calls: { args: string[]; opts: unknown }[]
} {
  const calls: { args: string[]; opts: unknown }[] = []
  let turn = 0
  return {
    calls,
    run: async (_cwd, args, _gitPath, opts) => {
      calls.push({ args, opts })
      const answer = answers[Math.min(turn, answers.length - 1)] ?? {}
      turn += 1
      return { code: answer.code ?? 0, stdout: answer.stdout ?? Buffer.from(''), stderr: answer.stderr ?? '' }
    },
  }
}

describe('remote', () => {
  it('fetches with one command and nothing added to it', async () => {
    const git = fakeGit([{ code: 0 }])
    expect(await remote('/r', 'fetch', undefined, git.run as never)).toEqual({ ok: true })
    expect(git.calls[0].args).toEqual(['fetch'])
  })

  // reason: `--rebase` or `--no-rebase` here would override the user's own
  // pull.rebase, which is a decision about their repository, not this app's.
  it('pulls plainly, so the user\'s own pull.rebase decides', async () => {
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'pull', undefined, git.run as never)
    expect(git.calls[0].args).toEqual(['pull'])
  })

  // reason: a force push from a panel is a force push nobody meant to do.
  it('pushes plainly, never with force', async () => {
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'push', undefined, git.run as never)
    expect(git.calls[0].args).toEqual(['push'])
    expect(git.calls[0].args.join(' ')).not.toContain('force')
  })

  // reason: a hand-authored "! [rejected] main -> main (fetch first)" — with
  // no `To <url>` line in front of it — is a string real git never produces;
  // this is real git's own stderr from a real non-fast-forward push.
  it('reports what git said when a real push is rejected, not the To line', async () => {
    const git = fakeGit([{ code: 1, stderr: REAL_PUSH_REJECTED }])
    const out = await remote('/r', 'push', undefined, git.run as never)
    expect(out).toEqual({ ok: false, reason: "error: failed to push some refs to '/repo/origin.git'" })
  })

  // reason: the pull side of the same defect — real git's own stderr from a
  // real divergent pull with no pull.rebase configured, exit 128.
  it('reports what git said when a real pull diverges, not the From line', async () => {
    const git = fakeGit([{ code: 128, stderr: REAL_PULL_DIVERGED }])
    const out = await remote('/r', 'pull', undefined, git.run as never)
    expect(out).toEqual({ ok: false, reason: 'fatal: Need to specify how to reconcile divergent branches.' })
  })

  // reason: the kind is what the panel hangs a button on; without it every
  // credential failure is a sentence the user can only read.
  it('names which trouble it was when it recognises one', async () => {
    const git = fakeGit([{ code: 1, stderr: "fatal: could not read Username for 'https://x': terminal prompts disabled" }])
    const out = await remote('/r', 'push', undefined, git.run as never)
    expect(out.ok).toBe(false)
    expect(out.trouble).toBe('https')
    if (!out.ok) expect(out.reason).toContain('HTTPS credential')
  })

  // reason: `git remote` names the remote, so nothing the renderer typed ever
  // reaches the command line — and HEAD names the branch, so nothing does.
  it('publishes to the only remote, by HEAD', async () => {
    const git = fakeGit([{ code: 0, stdout: Buffer.from('origin\n') }, { code: 0 }])
    expect(await remote('/r', 'publish', undefined, git.run as never)).toEqual({ ok: true })
    expect(git.calls[0].args).toEqual(['remote'])
    expect(git.calls[1].args).toEqual(['push', '--set-upstream', 'origin', 'HEAD'])
  })

  // reason: guessing which of several remotes the user meant is how work ends
  // up on a fork nobody was watching.
  it('refuses to guess between two remotes', async () => {
    const git = fakeGit([{ code: 0, stdout: Buffer.from('origin\nupstream\n') }])
    const out = await remote('/r', 'publish', undefined, git.run as never)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('more than one remote')
    expect(git.calls).toHaveLength(1)
  })

  it('says so when there is no remote at all', async () => {
    const git = fakeGit([{ code: 0, stdout: Buffer.from('') }])
    const out = await remote('/r', 'publish', undefined, git.run as never)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('no remote')
  })

  // reason: a cancel that reported git's silence as "git failed without
  // saying why" would read as a fault rather than as the thing just done.
  it('says a cancelled run was cancelled', async () => {
    const stop = new AbortController()
    stop.abort()
    const git = fakeGit([{ code: 1, stderr: '' }])
    const out = await remote('/r', 'fetch', stop.signal, git.run as never)
    expect(out).toEqual({ ok: false, reason: 'Cancelled.' })
  })

  // reason: the default thirty seconds is a normal first fetch on a large
  // repository, and being cut off there looks like a network fault.
  it('gives a remote operation longer than a local one', async () => {
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'fetch', undefined, git.run as never)
    expect((git.calls[0].opts as { timeoutMs: number }).timeoutMs).toBe(REMOTE_TIMEOUT_MS)
    expect(REMOTE_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('passes the signal through so the child can be killed', async () => {
    const stop = new AbortController()
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'fetch', stop.signal, git.run as never)
    expect((git.calls[0].opts as { signal: AbortSignal }).signal).toBe(stop.signal)
  })
})
