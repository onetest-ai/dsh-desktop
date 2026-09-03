import { describe, expect, it, vi } from 'vitest'
import { checkout, createBranch, parseBranches } from './git-branch'
import type { GitResult } from './git-run'

const bytes = (...lines: string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8')
const ok = (out = ''): GitResult => ({ code: 0, stdout: Buffer.from(out, 'utf8'), stderr: '' })
const fail = (why: string): GitResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: why })

describe('parseBranches', () => {
  it('reads the name, its upstream, and which one is current', () => {
    expect(parseBranches(bytes('feature\t\t ', 'main\torigin/main\t*'))).toEqual([
      { name: 'feature', upstream: '', current: false, remote: false },
      { name: 'main', upstream: 'origin/main', current: true, remote: false },
    ])
  })

  // reason: a remote-tracking branch is offered so it can be checked out,
  // which creates the local branch that follows it — but it is not itself a
  // branch you are ever on, and listing it beside local ones unmarked reads
  // as a duplicate.
  it('marks a remote-tracking branch as remote', () => {
    expect(parseBranches(bytes('origin/main\t\t '))).toEqual([
      { name: 'origin/main', upstream: '', current: false, remote: true },
    ])
  })

  // reason: `--all` lists this pointer, and it is not a branch anyone checks
  // out — leaving it in puts a nonsense entry at the top of the menu.
  it('leaves out the remote HEAD pointer', () => {
    expect(parseBranches(bytes('origin/HEAD\t\t ', 'main\t\t*')).map((each) => each.name)).toEqual(['main'])
  })

  it('reads nothing from nothing', () => {
    expect(parseBranches(Buffer.alloc(0))).toEqual([])
  })
})

describe('checkout', () => {
  it('switches to the branch it was given', async () => {
    const run = vi.fn(async () => ok())
    expect(await checkout('/r', 'feature', run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', 'feature'])
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
    const out = await checkout('/r', 'feature', run)
    expect(out.ok).toBe(false)
    expect(out.blocked).toEqual(['a.ts', 'src/b.ts'])
  })

  it('reports an ordinary failure with no blocked list', async () => {
    const run = vi.fn(async () => fail("error: pathspec 'nope' did not match any file(s) known to git"))
    const out = await checkout('/r', 'nope', run)
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
})
