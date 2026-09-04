// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BranchRowView, EntryView, RepoStatusView, StashRowView } from './git-rows.ts'

/**
 * The panel's markup, cut to the elements it writes into or reads by name.
 *
 * `git.html` declares more, but nothing else is reached by id: a fuller copy
 * here would be a second description of the page that could drift from it.
 */
function page(): void {
  document.body.innerHTML =
    '<p class="empty" id="git-empty" hidden></p>' +
    '<form id="commit-form" hidden><label id="commit-repo-row" hidden>' +
    '<select id="commit-repo"></select></label><textarea id="commit-message"></textarea>' +
    '<button type="submit" id="commit"></button></form>' +
    '<p class="git-note" id="git-note" hidden></p><div id="repos"></div>'
}

/** One repository as the bridge reports it, with the fields the panel reads. */
interface StubRepo {
  path: string
  name: string
  status: RepoStatusView
  branches: BranchRowView[]
  stashes: StashRowView[]
}

/** What one git write answered with, and a blocked checkout's file list. */
type StubResult =
  | { ok: true }
  | { ok: false; reason: string; blocked?: string[]; blockedKind?: 'tracked' | 'untracked' }

/** The sha a stubbed `pushStash` names the entry it created with. */
const PUSHED = 'e3b0c44298fc1c149afbf4c8996fb924'

/** What the stub bridge recorded, alongside the calls the panel makes on it. */
interface StubBridge {
  readGit: () => Promise<unknown>
  onGitChanged: (listener: () => void) => void
  openGitDiff: (repo: string, path: string, section: string) => void
  gitRowMenu: (section: string) => Promise<string | undefined>
  stageFiles: (repo: string, paths: string[]) => Promise<{ ok: true }>
  unstageFiles: (repo: string, paths: string[]) => Promise<{ ok: true }>
  discardFiles: (repo: string, tracked: string[], untracked: string[]) => Promise<{ ok: true }>
  commitFiles: (
    repo: string,
    message: string,
    add: string[],
    keep: string[],
    staged: string[],
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  checkoutBranch: (repo: string, name: string, remote: boolean) => Promise<StubResult>
  createBranch: (repo: string, name: string) => Promise<StubResult>
  pushStash: (repo: string, message: string, untracked?: boolean) => Promise<StubResult & { ref?: string }>
  applyStash: (repo: string, ref: string, pop: boolean) => Promise<StubResult>
  dropStash: (repo: string, ref: string) => Promise<StubResult>
  gitRemote: (
    repo: string,
    op: string,
  ) => Promise<StubResult & { trouble?: string }>
  cancelGitRemote: (repo: string) => void
  openGitTerminal: (repo: string) => void
  /** Answer the held `gitRemote`, as main would when git finished. */
  finish: (answer?: StubResult & { trouble?: string }) => void
  askTheme: () => void
  onTheme: () => void
  /** Fire the `git:changed` listener the panel registered, as main would. */
  fire: () => void
  /**
   * Every branch and stash call in the order they were made, named.
   *
   * One list rather than one per call: the stash-and-switch chain is about
   * order across three different operations, and separate lists cannot say
   * whether the pop came before or after the second checkout.
   */
  gitCalls: unknown[][]
  /** Every `commitFiles`, argument for argument. */
  commitCalls: unknown[][]
  /** Every `stageFiles`, `unstageFiles` and `discardFiles`, named. */
  actionCalls: unknown[][]
  /** Every `openGitDiff`. */
  diffCalls: unknown[][]
}

/**
 * A bridge that answers `readGit` with the repositories given and records the
 * writes the panel makes.
 * @param options - the repositories to report, what a commit answers, and what the row menu returns.
 * @returns the bridge, with its recordings.
 */
function stubBridge(options: {
  repos?: StubRepo[]
  reason?: string
  fail?: boolean
  menu?: string
  read?: () => Promise<unknown>
  /** What each `checkoutBranch` answers, in order; the last one repeats. */
  checkout?: StubResult[]
  /** What `pushStash` answers. */
  stashPush?: StubResult
  /**
   * The sha `pushStash` names its entry with, or null for one it could not.
   *
   * A sha rather than `stash@{0}`: main answers with the identity of the
   * entry it created, and a test that let the panel pop a position would not
   * notice the panel doing the same.
   */
  stashRef?: string | null
  /** What `applyStash` answers. */
  stashApply?: StubResult
  /** What `createBranch` answers. */
  branch?: StubResult
  /** What each `gitRemote` answers, in order; the last one repeats. */
  remote?: (StubResult & { trouble?: string })[]
  /** Makes `gitRemote` hang until the test resolves it with `finish`. */
  hold?: boolean
}): StubBridge {
  const commitCalls: unknown[][] = []
  const actionCalls: unknown[][] = []
  const diffCalls: unknown[][] = []
  const gitCalls: unknown[][] = []
  let checkouts = 0
  let remotes = 0
  let release: ((answer: StubResult & { trouble?: string }) => void) | undefined
  const nextCheckout = (): StubResult => {
    const answers = options.checkout ?? [{ ok: true }]
    const answer = answers[Math.min(checkouts, answers.length - 1)]
    checkouts += 1
    return answer
  }
  let changed: (() => void) | undefined
  return {
    checkoutBranch: async (repo, name, remote) => {
      gitCalls.push(['checkout', repo, name, remote])
      return nextCheckout()
    },
    createBranch: async (repo, name) => {
      gitCalls.push(['create-branch', repo, name])
      return options.branch ?? { ok: true }
    },
    pushStash: async (repo, message, untracked = false) => {
      // The flag is recorded with the call: which kind of block was being
      // cleared is the difference between a stash that clears it and one
      // that leaves the user with a stash they never asked for.
      gitCalls.push(['stash-push', repo, message, untracked])
      if (options.stashPush !== undefined) return options.stashPush
      return options.stashRef === null ? { ok: true } : { ok: true, ref: options.stashRef ?? PUSHED }
    },
    applyStash: async (repo, ref, pop) => {
      gitCalls.push(['stash-apply', repo, ref, pop])
      return options.stashApply ?? { ok: true }
    },
    dropStash: async (repo, ref) => {
      gitCalls.push(['stash-drop', repo, ref])
      return { ok: true }
    },
    gitRemote: async (repo, op) => {
      gitCalls.push(['remote', repo, op])
      if (options.hold === true) {
        return await new Promise<StubResult & { trouble?: string }>((resolve) => {
          release = resolve
        })
      }
      const answers = options.remote ?? [{ ok: true } as StubResult]
      const answer = answers[Math.min(remotes, answers.length - 1)]
      remotes += 1
      return answer
    },
    cancelGitRemote: (repo) => {
      gitCalls.push(['cancel-remote', repo])
    },
    openGitTerminal: (repo) => {
      gitCalls.push(['open-terminal', repo])
    },
    finish: (answer: StubResult & { trouble?: string } = { ok: true }) => release?.(answer),
    gitCalls,
    readGit: options.read ?? (async () => ({ ok: true, repos: options.repos ?? [] })),
    onGitChanged: (listener: () => void) => {
      changed = listener
    },
    fire: () => changed?.(),
    openGitDiff: (repo, path, section) => {
      diffCalls.push(['open-diff', repo, path, section])
    },
    gitRowMenu: async () => options.menu,
    stageFiles: async (repo, paths) => {
      actionCalls.push(['stage', repo, paths])
      return { ok: true }
    },
    unstageFiles: async (repo, paths) => {
      actionCalls.push(['unstage', repo, paths])
      return { ok: true }
    },
    discardFiles: async (repo, tracked, untracked) => {
      actionCalls.push(['discard', repo, tracked, untracked])
      return { ok: true }
    },
    commitFiles: async (repo, message, add, keep, staged) => {
      commitCalls.push([repo, message, add, keep, staged])
      return options.fail === true ? { ok: false, reason: options.reason ?? 'git said no' } : { ok: true }
    },
    askTheme: () => {},
    onTheme: () => {},
    commitCalls,
    actionCalls,
    diffCalls,
  }
}

/**
 * Load the panel against a stub bridge.
 *
 * The module reads once as it loads, so it is imported per test rather than
 * once for the file.
 * @param bridge - the bridge the panel talks to.
 * @returns resolution once that first read has been drawn.
 */
async function load(bridge: StubBridge): Promise<void> {
  ;(globalThis as unknown as { pane: unknown }).pane = bridge
  vi.resetModules()
  await import('./git.ts')
  // The load-time read, and the draw that follows it.
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/** One repository for the stub, with only the sections that were named. */
function repo(sections: {
  path?: string
  branch?: string
  staged?: EntryView[]
  changed?: EntryView[]
  untracked?: EntryView[]
  branches?: BranchRowView[]
  stashes?: StashRowView[]
}): StubRepo {
  const path = sections.path ?? '/r'
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    status: {
      branch: sections.branch ?? 'main',
      ahead: 0,
      behind: 0,
      staged: sections.staged ?? [],
      changed: sections.changed ?? [],
      untracked: sections.untracked ?? [],
    },
    branches: sections.branches ?? [],
    stashes: sections.stashes ?? [],
  }
}

/** Let every pending microtask in a chain of awaits settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/** Open the branch list on the first repository drawn. */
function openBranches(): void {
  ;(document.querySelector('.repo-branch') as HTMLButtonElement).click()
}

/** Press one branch in the open list, by the name it shows. */
function branchItem(name: string): HTMLButtonElement {
  const node = [...document.querySelectorAll('.branch-item')].find(
    (item) => item.querySelector('.branch-item-name')?.textContent === name,
  )
  if (node === undefined) throw new Error(`no branch item for ${name}`)
  return node as HTMLButtonElement
}

/** The panel's note line, which is where a refused action says why. */
function note(): string {
  return (document.getElementById('git-note') as HTMLElement).textContent ?? ''
}

/** What the panel is saying when it has nothing to list. */
function empty(): { text: string; hidden: boolean } {
  const node = document.getElementById('git-empty') as HTMLElement
  return { text: node.textContent ?? '', hidden: node.hidden }
}

/** The row checkbox for one path, which carries the path in its label. */
function tickFor(path: string): HTMLInputElement {
  const node = document.querySelector(`input[aria-label="Include ${path} in the next commit"]`)
  if (node === null) throw new Error(`no tick for ${path}`)
  return node as HTMLInputElement
}

/** One of a row's action buttons, by its label. */
function actionFor(path: string, label: string): HTMLButtonElement {
  const row = tickFor(path).parentElement as HTMLElement
  const node = row.querySelector(`button[aria-label="${label}"]`)
  if (node === null) throw new Error(`no ${label} on ${path}`)
  return node as HTMLButtonElement
}

/** Type a message and press Commit, then let the call settle. */
async function commit(message: string): Promise<void> {
  const box = document.getElementById('commit-message') as HTMLTextAreaElement
  box.value = message
  box.dispatchEvent(new Event('input'))
  ;(document.getElementById('commit') as HTMLButtonElement).click()
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

describe('the git panel', () => {
  beforeEach(() => {
    page()
  })

  it('words the state when the project holds no repository', async () => {
    await load(stubBridge({ repos: [] }))
    expect(empty()).toEqual({ text: 'No repository in this project.', hidden: false })
  })

  // reason: nothing on the other side of the bridge rejects today, so without
  // this the failure path is not merely untested but unwritten: `latest`
  // would stay unset, `draw` would keep the empty state hidden, and the panel
  // would be a blank column with no message and no way to ask again.
  it('says so when the read fails rather than staying blank', async () => {
    await load(
      stubBridge({
        read: async () => {
          throw new Error('the channel is gone')
        },
      }),
    )
    expect(empty().hidden).toBe(false)
    expect(empty().text).toContain('the channel is gone')
  })

  it('commits the ticked paths, with the message that was typed', async () => {
    const bridge = stubBridge({
      repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] })],
    })
    await load(bridge)
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/r', 'a message', ['a.ts'], [], []]])
  })

  // reason: an untracked file is one git has never seen, and committing a
  // file nobody noticed is how build output and credentials reach a
  // repository. It starts unticked and must stay out of the commit.
  it('does not commit an untracked file nobody ticked', async () => {
    const bridge = stubBridge({
      repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] })],
    })
    await load(bridge)
    expect(tickFor('new.ts').checked).toBe(false)
    await commit('a message')
    const [, , add, keep] = bridge.commitCalls[0] as [string, string, string[], string[], string[]]
    expect(add).not.toContain('new.ts')
    expect(keep).not.toContain('new.ts')
  })

  it('commits an untracked file once it has been ticked', async () => {
    const bridge = stubBridge({ repos: [repo({ untracked: [{ path: 'new.ts', status: '?' }] })] })
    await load(bridge)
    tickFor('new.ts').click()
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/r', 'a message', ['new.ts'], [], []]])
  })

  // reason: THE distinction this panel exists to get right. A staged tick
  // means "the version already recorded". Putting it through `git add` would
  // stage the working tree's newer content instead, silently replacing the
  // very thing the tick was protecting — so it travels in `keep`, never in
  // `add`, and this test fails the moment the two are confused.
  it('sends a staged-only tick as keep and never as add', async () => {
    const bridge = stubBridge({ repos: [repo({ staged: [{ path: 's.ts', status: 'M' }] })] })
    await load(bridge)
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/r', 'a message', [], ['s.ts'], ['s.ts']]])
  })

  // reason: a file staged and then edited again is listed twice, and the two
  // rows mean different content. One tick answering for both would commit
  // whichever the panel happened to look at.
  it('gives a file listed in two sections a tick of its own in each', async () => {
    const bridge = stubBridge({
      repos: [repo({ staged: [{ path: 'both.ts', status: 'M' }], changed: [{ path: 'both.ts', status: 'M' }] })],
    })
    await load(bridge)
    const ticks = [...document.querySelectorAll('input[aria-label="Include both.ts in the next commit"]')]
    expect(ticks).toHaveLength(2)
    // Untick the changed row — the edits made since — and the staged version
    // is what is left to commit.
    ;(ticks[1] as HTMLInputElement).click()
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/r', 'a message', [], ['both.ts'], ['both.ts']]])
  })

  it("clears the section's ticks from the heading, and fills them again", async () => {
    const bridge = stubBridge({
      repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] })],
    })
    await load(bridge)
    const heading = document.querySelector(
      'input[aria-label="Include every file under Changes in the next commit"]',
    ) as HTMLInputElement
    expect(heading.checked).toBe(true)
    heading.click()
    expect(tickFor('a.ts').checked).toBe(false)
    expect(tickFor('b.ts').checked).toBe(false)
    await commit('a message')
    expect(bridge.commitCalls).toEqual([])
  })

  // reason: the two arguments take different git commands. An untracked path
  // sent as tracked is restored from an index that has never heard of it.
  it('discards an untracked row through the untracked argument', async () => {
    const bridge = stubBridge({
      repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] })],
    })
    await load(bridge)
    actionFor('new.ts', 'Discard').click()
    actionFor('a.ts', 'Discard').click()
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(bridge.actionCalls).toEqual([
      ['discard', '/r', [], ['new.ts']],
      ['discard', '/r', ['a.ts'], []],
    ])
  })

  it('offers a staged row Unstage and the others Stage', async () => {
    const bridge = stubBridge({
      repos: [repo({ staged: [{ path: 's.ts', status: 'M' }], changed: [{ path: 'a.ts', status: 'M' }] })],
    })
    await load(bridge)
    actionFor('s.ts', 'Unstage').click()
    actionFor('a.ts', 'Stage').click()
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(bridge.actionCalls).toEqual([
      ['unstage', '/r', ['s.ts']],
      ['stage', '/r', ['a.ts']],
    ])
    expect(() => actionFor('s.ts', 'Discard')).toThrow()
  })

  it('acts on the whole repository from its header', async () => {
    const bridge = stubBridge({
      repos: [
        repo({
          staged: [{ path: 's.ts', status: 'M' }],
          changed: [{ path: 'a.ts', status: 'M' }],
          untracked: [{ path: 'new.ts', status: '?' }],
        }),
      ],
    })
    await load(bridge)
    const head = document.querySelector('.repo-head') as HTMLElement
    for (const label of ['Stage all', 'Unstage all', 'Discard all']) {
      ;(head.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click()
    }
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(bridge.actionCalls).toEqual([
      ['stage', '/r', ['a.ts', 'new.ts']],
      ['unstage', '/r', ['s.ts']],
      ['discard', '/r', ['a.ts'], ['new.ts']],
    ])
  })

  it('carries out what the native row menu returned', async () => {
    const bridge = stubBridge({
      repos: [repo({ untracked: [{ path: 'new.ts', status: '?' }] })],
      menu: 'discard',
    })
    await load(bridge)
    const row = tickFor('new.ts').parentElement as HTMLElement
    row.dispatchEvent(new Event('contextmenu'))
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(bridge.actionCalls).toEqual([['discard', '/r', [], ['new.ts']]])
  })

  // reason: a message the user typed is not thrown away because git refused
  // the commit it was written for.
  it('keeps the message and says why when the commit is refused', async () => {
    const bridge = stubBridge({
      repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }] })],
      fail: true,
      reason: 'r: nothing to commit',
    })
    await load(bridge)
    await commit('a message')
    expect((document.getElementById('commit-message') as HTMLTextAreaElement).value).toBe('a message')
    expect((document.getElementById('git-note') as HTMLElement).textContent).toBe('r: nothing to commit')
  })

  it('disables Commit with no message and with nothing ticked', async () => {
    const bridge = stubBridge({ repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }] })] })
    await load(bridge)
    const button = document.getElementById('commit') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Write a commit message.')
    const box = document.getElementById('commit-message') as HTMLTextAreaElement
    box.value = 'a message'
    box.dispatchEvent(new Event('input'))
    expect(button.disabled).toBe(false)
    tickFor('a.ts').click()
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Tick the files to include in the commit.')
  })

  // reason: a message means nothing across two repositories, and inferring
  // which one is meant from the ticks leaves a project of two dirty checkouts
  // unable to commit at all — tracked changes arrive ticked, so both are
  // always candidates until the user empties one.
  it('offers a selector when more than one repository is ticked, and commits the chosen one', async () => {
    const bridge = stubBridge({
      repos: [
        repo({ path: '/one', changed: [{ path: 'a.ts', status: 'M' }] }),
        repo({ path: '/two', changed: [{ path: 'b.ts', status: 'M' }] }),
      ],
    })
    await load(bridge)
    const row = document.getElementById('commit-repo-row') as HTMLElement
    const picker = document.getElementById('commit-repo') as HTMLSelectElement
    expect(row.hidden).toBe(false)
    expect([...picker.options].map((option) => option.value)).toEqual(['/one', '/two'])
    // The first by default, and Commit is available rather than disabled.
    expect(picker.value).toBe('/one')
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/one', 'a message', ['a.ts'], [], []]])
  })

  it('commits the repository the selector was changed to', async () => {
    const bridge = stubBridge({
      repos: [
        repo({ path: '/one', changed: [{ path: 'a.ts', status: 'M' }] }),
        repo({ path: '/two', changed: [{ path: 'b.ts', status: 'M' }] }),
      ],
    })
    await load(bridge)
    const picker = document.getElementById('commit-repo') as HTMLSelectElement
    picker.value = '/two'
    picker.dispatchEvent(new Event('change'))
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/two', 'a message', ['b.ts'], [], []]])
  })

  // reason: the options were once rebuilt only when a note kept beside the
  // `<select>` disagreed with the candidate list, and clearing the options as
  // the second repository stopped being a candidate did not clear that note.
  // Re-ticking the file — an ordinary undo — then matched the stale note, the
  // rebuild was skipped, and the selector came back visible and empty.
  it('refills the selector when a repository stops being a candidate and becomes one again', async () => {
    const bridge = stubBridge({
      repos: [
        repo({ path: '/one', changed: [{ path: 'a.ts', status: 'M' }] }),
        repo({ path: '/two', changed: [{ path: 'b.ts', status: 'M' }] }),
      ],
    })
    await load(bridge)
    const row = document.getElementById('commit-repo-row') as HTMLElement
    const picker = document.getElementById('commit-repo') as HTMLSelectElement
    expect([...picker.options].map((option) => option.value)).toEqual(['/one', '/two'])
    // Down to one candidate: the row goes away.
    tickFor('b.ts').click()
    expect(row.hidden).toBe(true)
    // And back up to two, which is where the selector was left empty.
    tickFor('b.ts').click()
    expect(row.hidden).toBe(false)
    expect([...picker.options].map((option) => option.value)).toEqual(['/one', '/two'])
    expect([...picker.options].map((option) => option.textContent)).toEqual(['one', 'two'])
    expect(picker.value).toBe('/one')
  })

  // reason: a control with one option is a control that only takes up room.
  it('shows no selector when only one repository has ticks', async () => {
    const bridge = stubBridge({
      repos: [
        repo({ path: '/one', changed: [{ path: 'a.ts', status: 'M' }] }),
        repo({ path: '/two' }),
      ],
    })
    await load(bridge)
    expect((document.getElementById('commit-repo-row') as HTMLElement).hidden).toBe(true)
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/one', 'a message', ['a.ts'], [], []]])
  })

  // reason: `draw` clears #repos, so a tick that redrew the panel took the
  // focused checkbox out of the document and put a keyboard user back at the
  // top of the panel on every space bar — undoing the reach the row was
  // restructured to give them.
  it('keeps focus on the tick that was just pressed', async () => {
    const bridge = stubBridge({
      repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] })],
    })
    await load(bridge)
    const tick = tickFor('a.ts')
    tick.focus()
    tick.click()
    expect(tick.checked).toBe(false)
    expect(document.activeElement).toBe(tick)
    // And the section heading followed it into the half-ticked state without
    // anything being redrawn.
    const heading = document.querySelector(
      'input[aria-label="Include every file under Changes in the next commit"]',
    ) as HTMLInputElement
    expect(heading.checked).toBe(false)
    expect(heading.indeterminate).toBe(true)
  })

  // reason: a redraw the user did not ask for must not move the keyboard
  // either — a watcher fires while the pointer is nowhere near the panel.
  it('puts focus back on the same row after a refresh redraws the panel', async () => {
    const bridge = stubBridge({ repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }] })] })
    await load(bridge)
    const before = actionFor('a.ts', 'Stage')
    before.focus()
    bridge.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    const after = actionFor('a.ts', 'Stage')
    expect(after).not.toBe(before)
    expect(document.activeElement).toBe(after)
  })

  // reason: Discard All on a clean repository raises the panel's one
  // unrecoverable warning to ask about nothing, which teaches the user to
  // dismiss the dialog that must never be dismissed out of habit.
  it('offers a clean repository none of the working-tree header actions', async () => {
    const bridge = stubBridge({ repos: [repo({ path: '/one' }), repo({ path: '/two', changed: [{ path: 'a.ts', status: 'M' }] })] })
    await load(bridge)
    const heads = [...document.querySelectorAll('.repo-head')]
    expect(heads).toHaveLength(2)
    // Fetch, pull and push stay offered: they act on the remote, not on the
    // working tree, so a clean repository has as much reason to reach for
    // them as one with changes to stage.
    expect([...heads[0].querySelectorAll('.row-action')].map((node) => node.getAttribute('aria-label'))).toEqual([
      'Fetch, pull or push',
    ])
    expect([...heads[1].querySelectorAll('.row-action')].map((node) => node.getAttribute('aria-label'))).toEqual([
      'Stage all',
      'Discard all',
      'Stash',
      'Fetch, pull or push',
    ])
  })

  it('opens the branch list from the header, remote-tracking ones under a divider', async () => {
    const bridge = stubBridge({
      repos: [
        repo({
          branches: [
            { name: 'main', upstream: 'origin/main', current: true, remote: false },
            { name: 'feature', upstream: '', current: false, remote: false },
            { name: 'origin/other', upstream: '', current: false, remote: true },
          ],
        }),
      ],
    })
    await load(bridge)
    expect(document.querySelector('.branch-menu')).toBeNull()
    openBranches()
    const items = [...document.querySelectorAll('.branch-item-name')].map((node) => node.textContent)
    expect(items).toEqual(['main', 'feature', 'origin/other'])
    expect(document.querySelector('.branch-divider')?.textContent).toBe('Remote')
    // The one you are on is marked rather than left out.
    expect(branchItem('main').classList.contains('branch-current')).toBe(true)
    expect((document.querySelector('.branch-new') as HTMLElement).textContent).toBe('New branch…')
  })

  // reason: the button that opened the list sits above it in the tab order,
  // so without Escape the only way out of an open list is to tab through
  // every branch in it.
  it('shuts the branch list on Escape from the control that opened it', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
    })
    await load(bridge)
    // As a keyboard user opens it: focus the branch control and press it. The
    // menu is drawn below that control, so focus stays outside the list — a
    // handler bound to the list would never hear this Escape at all.
    const opener = document.querySelector('.repo-branch') as HTMLButtonElement
    opener.focus()
    opener.click()
    const button = document.querySelector('.repo-branch') as HTMLButtonElement
    expect(document.querySelector('.branch-menu')).not.toBeNull()
    expect(document.activeElement).toBe(button)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('.branch-menu')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('.repo-branch'))
    expect(bridge.gitCalls).toEqual([])
  })

  // reason: a remote-tracking branch checked out without the flag detaches
  // HEAD instead of creating the local branch that follows it, which is what
  // anyone picking `origin/other` off a list means by it. The name alone
  // cannot be classified — a local `feature/thing` has a slash too.
  it('checks a remote-tracking branch out as a remote one', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'origin/other', upstream: '', current: false, remote: true }] })],
    })
    await load(bridge)
    openBranches()
    branchItem('origin/other').click()
    await settle()
    expect(bridge.gitCalls).toEqual([['checkout', '/r', 'origin/other', true]])
  })

  it('shows the reason and offers nothing when a switch fails for another cause', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [{ ok: false, reason: 'r: pathspec did not match' }],
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    expect(note()).toBe('r: pathspec did not match')
    expect(document.querySelector('.branch-blocked')).toBeNull()
  })

  it('offers to stash when a switch is blocked, naming what is in the way', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [{ ok: false, reason: 'error: local changes', blocked: ['a.ts', 'src/b.ts'] }, { ok: true }],
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    const offer = document.querySelector('.branch-blocked')
    expect(offer?.textContent).toContain('a.ts')
    expect(offer?.textContent).toContain('src/b.ts')
    ;(offer?.querySelector('button') as HTMLButtonElement).click()
    await settle()
    expect(bridge.gitCalls).toEqual([
      ['checkout', '/r', 'feature', false],
      ['stash-push', '/r', 'Switching to feature', false],
      ['checkout', '/r', 'feature', false],
      ['stash-apply', '/r', PUSHED, true],
    ])
    // Nothing failed, so nothing is said and the offer is gone.
    expect(note()).toBe('')
    expect(document.querySelector('.branch-blocked')).toBeNull()
  })

  // reason: the stash is what makes the second checkout possible. Carrying on
  // after it failed would run a checkout git has already refused and then pop
  // whatever stash happened to be on top — someone else's work, from before.
  it('stops the chain when the stash fails, and says so', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [{ ok: false, reason: 'error: local changes', blocked: ['a.ts'] }, { ok: true }],
      stashPush: { ok: false, reason: 'r: there is nothing to stash' },
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    ;(document.querySelector('.branch-blocked button') as HTMLButtonElement).click()
    await settle()
    expect(bridge.gitCalls).toEqual([
      ['checkout', '/r', 'feature', false],
      ['stash-push', '/r', 'Switching to feature', false],
    ])
    expect(note()).toContain('stash failed')
    expect(note()).toContain('nothing to stash')
  })

  // reason: the work is now in a stash the user never asked for. Reporting
  // this as a success would leave them on the old branch believing they are
  // on the new one, with their changes nowhere they can see.
  it('stops the chain when the second switch fails, and says the work is stashed', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [
        { ok: false, reason: 'error: local changes', blocked: ['a.ts'] },
        { ok: false, reason: 'r: index.lock exists' },
      ],
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    ;(document.querySelector('.branch-blocked button') as HTMLButtonElement).click()
    await settle()
    expect(bridge.gitCalls).toEqual([
      ['checkout', '/r', 'feature', false],
      ['stash-push', '/r', 'Switching to feature', false],
      ['checkout', '/r', 'feature', false],
    ])
    expect(note()).toContain('stashed')
    expect(note()).toContain('index.lock')
  })

  // reason: a pop can conflict on the far side, which leaves the stash in
  // place and the tree half-merged. That is a failure, and a chain that
  // reported it as a completed switch would send the user off believing their
  // work was restored when it is still in the stash.
  it('reports a pop that failed rather than calling the switch done', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [{ ok: false, reason: 'error: local changes', blocked: ['a.ts'] }, { ok: true }],
      stashApply: { ok: false, reason: 'r: CONFLICT in a.ts' },
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    ;(document.querySelector('.branch-blocked button') as HTMLButtonElement).click()
    await settle()
    expect(note()).toContain('pop failed')
    expect(note()).toContain('still stashed')
    expect(note()).toContain('CONFLICT in a.ts')
  })

  it('creates a branch from the header prompt on Enter, and cancels on Escape', async () => {
    const bridge = stubBridge({ repos: [repo({ branches: [] })] })
    await load(bridge)
    openBranches()
    ;(document.querySelector('.branch-new') as HTMLButtonElement).click()
    const input = document.querySelector('.branch-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    input.value = 'wip'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.branch-input')).toBeNull()
    expect(bridge.gitCalls).toEqual([])
    openBranches()
    ;(document.querySelector('.branch-new') as HTMLButtonElement).click()
    const again = document.querySelector('.branch-input') as HTMLInputElement
    again.value = 'wip'
    again.dispatchEvent(new Event('input'))
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    expect(bridge.gitCalls).toEqual([['create-branch', '/r', 'wip']])
  })

  // reason: `#repos` is rebuilt by every refresh, and a watcher fires
  // whenever anything under `.git` moves. A name half-typed into an input the
  // redraw threw away is a name the user types twice.
  it('keeps a half-typed branch name across a refresh', async () => {
    const bridge = stubBridge({ repos: [repo({})] })
    await load(bridge)
    openBranches()
    ;(document.querySelector('.branch-new') as HTMLButtonElement).click()
    const input = document.querySelector('.branch-input') as HTMLInputElement
    input.value = 'half'
    input.dispatchEvent(new Event('input'))
    bridge.fire()
    await settle()
    expect((document.querySelector('.branch-input') as HTMLInputElement).value).toBe('half')
  })

  it('stashes the working tree with the message typed in the header', async () => {
    const bridge = stubBridge({ repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }] })] })
    await load(bridge)
    const head = document.querySelector('.repo-head') as HTMLElement
    ;(head.querySelector('button[aria-label="Stash"]') as HTMLButtonElement).click()
    const input = document.querySelector('.branch-input') as HTMLInputElement
    input.value = 'the thing I was doing'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    expect(bridge.gitCalls).toEqual([['stash-push', '/r', 'the thing I was doing', false]])
  })

  // reason: `git stash push` leaves untracked files where they are, so on a
  // repository whose only changes are untracked the button would report
  // having stashed nothing.
  it('offers Stash only when there is a working tree to take', async () => {
    const bridge = stubBridge({ repos: [repo({ untracked: [{ path: 'new.ts', status: '?' }] })] })
    await load(bridge)
    expect(document.querySelector('button[aria-label="Stash"]')).toBeNull()
  })

  it('lists the stashes with the branch they were made on, and acts on one', async () => {
    const bridge = stubBridge({
      repos: [
        repo({
          stashes: [
            { ref: 'stash@{0}', sha: 'aaaaaaaa1111', branch: 'main', message: 'the thing' },
            { ref: 'stash@{1}', sha: 'bbbbbbbb2222', branch: 'feature', message: 'another' },
          ],
        }),
      ],
    })
    await load(bridge)
    const rows = [...document.querySelectorAll('.stash-row')]
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.stash-message')?.textContent).toBe('the thing')
    expect(rows[0].querySelector('.git-dir')?.textContent).toBe('main')
    for (const label of ['Apply stash@{1}', 'Pop stash@{1}', 'Drop stash@{1}']) {
      ;(rows[1].querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click()
    }
    await settle()
    // Labelled by position, acting by sha: a position is what the row shows,
    // and the sha is what survives an agent stashing in the same repository
    // between the click and the command — or, for Drop, the whole time the
    // native confirmation stands open.
    expect(bridge.gitCalls).toEqual([
      ['stash-apply', '/r', 'bbbbbbbb2222', false],
      ['stash-apply', '/r', 'bbbbbbbb2222', true],
      ['stash-drop', '/r', 'bbbbbbbb2222'],
    ])
  })

  // reason: `git stash push` leaves untracked files in the tree, so when the
  // block is untracked files a stash without `-u` clears nothing: the tracked
  // work goes into a stash nobody asked for, the second checkout is refused
  // again, and the user is told their changes are stashed and the switch
  // failed. The flag is the difference between the offer working and the
  // offer making things worse.
  it('takes untracked files with it when they are what blocked the switch', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [
        { ok: false, reason: 'error: untracked', blocked: ['notes.md'], blockedKind: 'untracked' },
        { ok: true },
      ],
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    const offer = document.querySelector('.branch-blocked')
    // And the note says so: stashing a file git has never seen takes it off
    // disk, which the user has to know before pressing the button.
    expect(offer?.textContent).toContain('untracked')
    expect(offer?.textContent).toContain('notes.md')
    ;(offer?.querySelector('button') as HTMLButtonElement).click()
    await settle()
    expect(bridge.gitCalls).toEqual([
      ['checkout', '/r', 'feature', false],
      ['stash-push', '/r', 'Switching to feature', true],
      ['checkout', '/r', 'feature', false],
      ['stash-apply', '/r', PUSHED, true],
    ])
  })

  // reason: `-u` sweeps build output and local scratch off disk into the
  // stash. It is for the untracked block alone, never for the ordinary one.
  it('leaves untracked files alone when tracked changes were the block', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [
        { ok: false, reason: 'error: local changes', blocked: ['a.ts'], blockedKind: 'tracked' },
        { ok: true },
      ],
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    ;(document.querySelector('.branch-blocked button') as HTMLButtonElement).click()
    await settle()
    expect(bridge.gitCalls).toContainEqual(['stash-push', '/r', 'Switching to feature', false])
  })

  // reason: `stash@{0}` is a position. The checkout between the push and the
  // pop takes anything up to seconds on a large tree, and an agent stashing in
  // the same repository during that window takes the top of the stack — so
  // popping by position would apply the agent's work, delete its entry,
  // strand the user's, and report a successful switch.
  it('pops the entry the push named, not whatever is on top of the stack', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [{ ok: false, reason: 'error: local changes', blocked: ['a.ts'] }, { ok: true }],
      stashRef: 'ffffffffffffffffffffffffffffffff',
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    ;(document.querySelector('.branch-blocked button') as HTMLButtonElement).click()
    await settle()
    const applied = bridge.gitCalls.filter((call) => call[0] === 'stash-apply')
    expect(applied).toEqual([['stash-apply', '/r', 'ffffffffffffffffffffffffffffffff', true]])
    expect(note()).toBe('')
  })

  // reason: with no handle that survives another process stashing, there is
  // nothing safe to pop. Stopping before the switch leaves the work in the
  // list and says where it is, which is the only honest answer.
  it('stops before the switch when the push could not name its entry', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [{ ok: false, reason: 'error: local changes', blocked: ['a.ts'] }, { ok: true }],
      stashRef: null,
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    await settle()
    ;(document.querySelector('.branch-blocked button') as HTMLButtonElement).click()
    await settle()
    expect(bridge.gitCalls).toEqual([
      ['checkout', '/r', 'feature', false],
      ['stash-push', '/r', 'Switching to feature', false],
    ])
    expect(note()).toContain('stashed')
    expect(note()).toContain('nothing was switched')
  })

  // reason: `draw` restores focus only to a control that is still there, and
  // picking a branch removes the item that was pressed. Focus would fall to
  // `<body>`, putting a keyboard user back at the top of the panel — and, on
  // the blocked path, several tabs away from the one control the note exists
  // for.
  it('keeps the keyboard on the branch control after a branch is picked', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })],
      checkout: [{ ok: false, reason: 'error: local changes', blocked: ['a.ts'] }],
    })
    await load(bridge)
    openBranches()
    branchItem('feature').click()
    expect(document.activeElement).toBe(document.querySelector('.repo-branch'))
    await settle()
    // And the blocked note drawing under it does not take the keyboard away.
    expect(document.querySelector('.branch-blocked')).not.toBeNull()
    expect(document.activeElement).toBe(document.querySelector('.repo-branch'))
  })

  // reason: nothing happens and nothing is drawn, so a lost focus here is
  // invisible — the panel simply stops responding to the keyboard.
  it('keeps the keyboard on the branch control after picking the current branch', async () => {
    const bridge = stubBridge({
      repos: [repo({ branches: [{ name: 'main', upstream: '', current: true, remote: false }] })],
    })
    await load(bridge)
    openBranches()
    branchItem('main').click()
    expect(document.querySelector('.branch-menu')).toBeNull()
    expect(bridge.gitCalls).toEqual([])
    expect(document.activeElement).toBe(document.querySelector('.repo-branch'))
  })

  it('keeps the keyboard on the branch control when the header prompt is cancelled', async () => {
    await load(stubBridge({ repos: [repo({})] }))
    openBranches()
    ;(document.querySelector('.branch-new') as HTMLButtonElement).click()
    const input = document.querySelector('.branch-input') as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.branch-input')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('.repo-branch'))
  })

  it('draws no Stashes section when there are none', async () => {
    await load(stubBridge({ repos: [repo({ changed: [{ path: 'a.ts', status: 'M' }] })] }))
    const titles = [...document.querySelectorAll('.section-title')].map((node) => node.textContent ?? '')
    expect(titles.some((title) => title.startsWith('Stashes'))).toBe(false)
    expect(document.querySelector('.stash-row')).toBeNull()
  })
  // reason: git records a rename as ONE entry with two names — the deletion
  // of the old beside the addition of the new. The panel sends only the new
  // path, so `commit` unstages that and leaves the staged deletion of the old
  // one in the index — and `git commit` commits the whole index, so the
  // commit records "delete the old file" and leaves the new one untracked.
  it('names both halves of a staged rename as staged, so unticking clears both', async () => {
    const bridge = stubBridge({
      repos: [
        repo({
          staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }],
          changed: [{ path: 'other.ts', status: 'M' }],
        }),
      ],
    })
    await load(bridge)
    tickFor('new.ts').click()
    await commit('a message')
    const [, , , keep, staged] = bridge.commitCalls[0] as [string, string, string[], string[], string[]]
    expect(staged).toEqual(['new.ts', 'old.ts'])
    // Unticked, so neither half is kept — main unstages both, and the commit
    // carries no half of the rename.
    expect(keep).toEqual([])
  })

  // reason: the same entry ticked must keep BOTH names, or `commit`'s
  // reconciliation unstages the deletion of the old one and the rename is
  // committed as an addition with the old file still there.
  it('keeps both halves of a staged rename that is left ticked', async () => {
    const bridge = stubBridge({ repos: [repo({ staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }] })] })
    await load(bridge)
    expect(tickFor('new.ts').checked).toBe(true)
    await commit('a message')
    const [, , , keep, staged] = bridge.commitCalls[0] as [string, string, string[], string[], string[]]
    expect(keep).toEqual(['new.ts', 'old.ts'])
    expect(staged).toEqual(['new.ts', 'old.ts'])
  })

  // reason: git puts `from` on both halves of a rename record, so `git mv old
  // new` followed by editing `new` is a staged `R new (from old)` and a
  // changed `M new`, both ticked. The commit has to restage the new content
  // and leave the staged deletion of the old name alone — anything that
  // unstages `old.ts` records an addition beside a file that is still there,
  // which is a copy and not a rename.
  it('commits a renamed-then-edited file as a rename, not as a copy', async () => {
    const bridge = stubBridge({
      repos: [
        repo({
          staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }],
          changed: [{ path: 'new.ts', status: 'M', from: 'old.ts' }],
        }),
      ],
    })
    await load(bridge)
    await commit('a message')
    // `staged` names both halves, so `keep` must name the old one or main
    // unstages it; the new one is in `add`, which restages the fresh content.
    expect(bridge.commitCalls).toEqual([['/r', 'a message', ['new.ts'], ['old.ts'], ['new.ts', 'old.ts']]])
  })

  // reason: the per-row Unstage half-unstages a rename in the same way — it
  // takes the new name out of the index and leaves the deletion of the old.
  it('unstages both names from the row button', async () => {
    const bridge = stubBridge({ repos: [repo({ staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }] })] })
    await load(bridge)
    actionFor('new.ts', 'Unstage').click()
    await settle()
    expect(bridge.actionCalls).toEqual([['unstage', '/r', ['new.ts', 'old.ts']]])
  })

  it('unstages both names from the row menu', async () => {
    const bridge = stubBridge({
      repos: [repo({ staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }] })],
      menu: 'unstage',
    })
    await load(bridge)
    const row = tickFor('new.ts').parentElement as HTMLElement
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    expect(bridge.actionCalls).toEqual([['unstage', '/r', ['new.ts', 'old.ts']]])
  })

  it('unstages both names of a rename from Unstage all', async () => {
    const bridge = stubBridge({ repos: [repo({ staged: [{ path: 'new.ts', status: 'R', from: 'old.ts' }] })] })
    await load(bridge)
    const head = document.querySelector('.repo-head') as HTMLElement
    ;(head.querySelector('button[aria-label="Unstage all"]') as HTMLButtonElement).click()
    await settle()
    expect(bridge.actionCalls).toEqual([['unstage', '/r', ['new.ts', 'old.ts']]])
  })
})

describe('the remote', () => {
  /**
   * Press the header's sync control, and then one item in the menu it opens.
   * @param label - the item's accessible name, as `Fetch`, `Pull` or `Push`.
   */
  function pressSync(label: string): void {
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Fetch, pull or push',
    )
    open?.click()
    const item = [...document.querySelectorAll<HTMLButtonElement>('.sync-item')].find(
      (button) => button.textContent === label,
    )
    item?.click()
  }

  it('offers fetch, pull and push behind one control', async () => {
    const bridge = stubBridge({ repos: [repo({})] })
    await load(bridge)
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Fetch, pull or push',
    )
    expect(open).toBeDefined()
    open?.click()
    expect([...document.querySelectorAll('.sync-item')].map((node) => node.textContent)).toEqual([
      'Fetch',
      'Pull',
      'Push',
    ])
  })

  it('asks main for the operation that was chosen', async () => {
    const bridge = stubBridge({ repos: [repo({})] })
    await load(bridge)
    pressSync('Pull')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(bridge.gitCalls).toContainEqual(['remote', '/r', 'pull'])
  })

  // reason: these take seconds, and a panel that looked idle through all of
  // them would be pressed again — which main refuses, so the second press
  // would read as the panel being broken.
  it('shows that it is running, and offers to stop it', async () => {
    const bridge = stubBridge({ repos: [repo({})], hold: true })
    await load(bridge)
    pressSync('Fetch')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(document.querySelector('.sync-running')?.textContent).toContain('Fetching')
    const cancel = document.querySelector<HTMLButtonElement>('.sync-cancel')
    expect(cancel).not.toBeNull()
    cancel?.click()
    expect(bridge.gitCalls).toContainEqual(['cancel-remote', '/r'])
  })

  it('clears the running state when the operation answers', async () => {
    const bridge = stubBridge({ repos: [repo({})], hold: true })
    await load(bridge)
    pressSync('Fetch')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    bridge.finish({ ok: true })
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(document.querySelector('.sync-running')).toBeNull()
  })

  // reason: a failure with nothing recognisable in it is an ordinary failure,
  // and the note is where every other ordinary failure in this panel is said.
  it('says what git said when it was not a trouble it knows', async () => {
    const bridge = stubBridge({ repos: [repo({})], remote: [{ ok: false, reason: 'fetch first' }] })
    await load(bridge)
    pressSync('Push')
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(document.getElementById('git-note')?.textContent).toBe('fetch first')
  })

  // reason: two operations at once in one repository is what main refuses, so
  // the panel should not be able to ask for it.
  it('does not offer the menu while something is running', async () => {
    const bridge = stubBridge({ repos: [repo({})], hold: true })
    await load(bridge)
    pressSync('Fetch')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Fetch, pull or push',
    )
    expect(open).toBeUndefined()
  })
})
