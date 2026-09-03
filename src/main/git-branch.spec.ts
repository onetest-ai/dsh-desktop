import { describe, expect, it, vi } from 'vitest'
import { checkout, createBranch, parseBranches } from './git-branch'
import type { GitResult } from './git-run'

const bytes = (...lines: string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8')
const ok = (out = ''): GitResult => ({ code: 0, stdout: Buffer.from(out, 'utf8'), stderr: '' })
const fail = (why: string): GitResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: why })

describe('parseBranches', () => {
  it('reads the name, its upstream, and which one is current', () => {
    expect(
      parseBranches(
        bytes(
          'refs/heads/feature\tfeature\t\t ',
          'refs/heads/main\tmain\torigin/main\t*',
        ),
      ),
    ).toEqual([
      { name: 'feature', upstream: '', current: false, remote: false },
      { name: 'main', upstream: 'origin/main', current: true, remote: false },
    ])
  })

  // reason: a remote-tracking branch is offered so it can be checked out,
  // which creates the local branch that follows it — but it is not itself a
  // branch you are ever on, and listing it beside local ones unmarked reads
  // as a duplicate.
  it('marks a remote-tracking branch as remote', () => {
    expect(parseBranches(bytes('refs/remotes/origin/main\torigin/main\t\t '))).toEqual([
      { name: 'origin/main', upstream: '', current: false, remote: true },
    ])
  })

  // reason: a local branch with a slash in its name (e.g. feature/thing, bugfix/123)
  // is just as much a branch as origin/main, and is only distinguished by the full
  // refname: refs/heads/... is local, refs/remotes/... is remote-tracking.
  it('classifies a local branch with slashes as local, not remote', () => {
    expect(parseBranches(bytes('refs/heads/feature/thing\tfeature/thing\t\t '))).toEqual([
      { name: 'feature/thing', upstream: '', current: false, remote: false },
    ])
  })

  // reason: `--all` lists this pointer, and it is not a branch anyone checks
  // out — leaving it in puts a nonsense entry at the top of the menu.
  it('leaves out the remote HEAD pointer', () => {
    expect(
      parseBranches(
        bytes('refs/remotes/origin/HEAD\torigin/HEAD\t\t ', 'refs/heads/main\tmain\t\t*'),
      ).map((each) => each.name),
    ).toEqual(['main'])
  })

  it('reads nothing from nothing', () => {
    expect(parseBranches(Buffer.alloc(0))).toEqual([])
  })
})

describe('checkout', () => {
  it('switches to a local branch', async () => {
    const run = vi.fn(async () => ok())
    expect(await checkout('/r', 'feature', false, run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', 'feature'])
  })

  it('tracks a remote branch instead of detaching HEAD', async () => {
    const run = vi.fn(async () => ok())
    expect(await checkout('/r', 'origin/main', true, run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', '--track', 'origin/main'])
  })

  // reason: git refuses only when the changes would be overwritten, and it
  // names the files. Those names are the whole content of the offer to stash
  // — an offer that cannot say what is in the way is a shrug with a button.
  it('reports which files blocked a refused switch', async () => {
    const run = vi.fn(async () =>
      fail(
        'error: Your local changes to the following files would be overwritten by checkout:\n' +
          '\ta.ts\n\tsrc/b.ts\n' +
          'Please commit your changes or stash them before you switch branches.\n',
      ),
    )
    const out = await checkout('/r', 'feature', false, run)
    expect(out.ok).toBe(false)
    expect(out.blocked).toEqual(['a.ts', 'src/b.ts'])
  })

  // reason: git prints a different sentence for untracked files, and `git
  // stash push` does not take them — so the offer built from a block has to
  // say which kind it was, or the chain stashes the tracked work for nothing
  // and the second checkout refuses again.
  it('tells the untracked refusal apart from the tracked one', async () => {
    const run = vi.fn(async () =>
      fail(
        'error: The following untracked working tree files would be overwritten by checkout:\n' +
          '\tnotes.md\n' +
          'Please move or remove them before you switch branches.\n',
      ),
    )
    const out = await checkout('/r', 'feature', false, run)
    expect(out.blocked).toEqual(['notes.md'])
    expect(out.blockedKind).toBe('untracked')
  })

  it('calls the tracked refusal tracked', async () => {
    const run = vi.fn(async () =>
      fail('error: Your local changes to the following files would be overwritten by checkout:\n\ta.ts\n'),
    )
    expect((await checkout('/r', 'feature', false, run)).blockedKind).toBe('tracked')
  })

  // reason: git can print both messages at once, and the untracked half is
  // the one a plain stash would not clear. Offering the weaker stash there
  // leaves the block in place and the user with a stash they never asked for.
  it('calls a block that is both kinds untracked', async () => {
    const run = vi.fn(async () =>
      fail(
        'error: Your local changes to the following files would be overwritten by checkout:\n\ta.ts\n' +
          'error: The following untracked working tree files would be overwritten by checkout:\n\tnotes.md\n',
      ),
    )
    expect((await checkout('/r', 'feature', false, run)).blockedKind).toBe('untracked')
  })

  // reason: `git checkout -f` force-restores the working tree from HEAD —
  // every uncommitted change in the repository is gone, with no dialog and
  // nothing in the reflog — and `git checkout .` does the same through the
  // pathspec. The ref position has no `--` to hide behind, so the shape is
  // refused before a command is built out of it.
  it('refuses a name git would read as an option, without running git', async () => {
    const run = vi.fn(async () => ok())
    expect(await checkout('/r', '-f', false, run)).toEqual({ ok: false, reason: 'That is not a branch name.' })
    expect(run).not.toHaveBeenCalled()
    // Non-vacuous: the same stub does run for an ordinary name, so the
    // refusal above is the guard and not a test that never reaches git.
    expect(await checkout('/r', 'f', false, run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', 'f'])
  })

  it('refuses the pathspec that would discard the working tree', async () => {
    const run = vi.fn(async () => ok())
    expect(await checkout('/r', '.', false, run)).toEqual({ ok: false, reason: 'That is not a branch name.' })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports an ordinary failure with no blocked list', async () => {
    const run = vi.fn(async () => fail("error: pathspec 'nope' did not match any file(s) known to git"))
    const out = await checkout('/r', 'nope', false, run)
    expect(out).toMatchObject({ ok: false })
    expect(out.blocked).toBeUndefined()
  })
})

describe('createBranch', () => {
  it('creates the branch and switches to it', async () => {
    const run = vi.fn(async () => ok())
    expect(await createBranch('/r', 'feature', run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', '-b', 'feature'])
  })

  // reason: git's own rules are long and this is not the place to
  // reimplement them — but a blank name and a leading dash are worth
  // catching before a command is built out of them.
  it('refuses a blank name without running git', async () => {
    const run = vi.fn(async () => ok())
    expect(await createBranch('/r', '  ', run)).toEqual({ ok: false, reason: 'Name the branch first.' })
    expect(run).not.toHaveBeenCalled()
  })

  // reason: `git checkout -b -f` is not a branch called `-f`; the same
  // destruction is one argument away here as it is in `checkout`.
  it('refuses a name git would read as an option, without running git', async () => {
    const run = vi.fn(async () => ok())
    expect(await createBranch('/r', '-f', run)).toEqual({ ok: false, reason: 'That is not a branch name.' })
    expect(run).not.toHaveBeenCalled()
    // Non-vacuous: an ordinary name does reach git through this same stub.
    expect(await createBranch('/r', 'f', run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', '-b', 'f'])
  })

  // reason: git writes a hook's rejection to stdout, so a `pre-checkout` or
  // `post-checkout` hook that refuses would otherwise report as "git failed
  // without saying why."
  it('falls back to what git said on stdout when stderr is silent', async () => {
    const run = vi.fn(async () => ({
      code: 1,
      stdout: Buffer.from('running hooks\nhusky - pre-commit hook exited with code 1\n', 'utf8'),
      stderr: '',
    }))
    expect(await createBranch('/r', 'feature', run)).toEqual({
      ok: false,
      reason: 'husky - pre-commit hook exited with code 1',
    })
  })
})
