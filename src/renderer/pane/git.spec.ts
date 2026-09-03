// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryView, RepoStatusView } from './git-rows.ts'

/**
 * The panel's markup, cut to the elements it writes into or reads by name.
 *
 * `git.html` declares more, but nothing else is reached by id: a fuller copy
 * here would be a second description of the page that could drift from it.
 */
function page(): void {
  document.body.innerHTML =
    '<p class="empty" id="git-empty" hidden></p>' +
    '<form id="commit-form" hidden><textarea id="commit-message"></textarea>' +
    '<button type="submit" id="commit"></button></form>' +
    '<p class="git-note" id="git-note" hidden></p><div id="repos"></div>'
}

/** One repository as the bridge reports it, with the fields the panel reads. */
interface StubRepo {
  path: string
  name: string
  status: RepoStatusView
  branches: never[]
  stashes: never[]
}

/** What the stub bridge recorded, alongside the calls the panel makes on it. */
interface StubBridge {
  readGit: () => Promise<unknown>
  onGitChanged: () => void
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
  askTheme: () => void
  onTheme: () => void
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
}): StubBridge {
  const commitCalls: unknown[][] = []
  const actionCalls: unknown[][] = []
  const diffCalls: unknown[][] = []
  return {
    readGit: options.read ?? (async () => ({ ok: true, repos: options.repos ?? [] })),
    onGitChanged: () => {},
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
  staged?: EntryView[]
  changed?: EntryView[]
  untracked?: EntryView[]
}): StubRepo {
  const path = sections.path ?? '/r'
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    status: {
      branch: 'main',
      ahead: 0,
      behind: 0,
      staged: sections.staged ?? [],
      changed: sections.changed ?? [],
      untracked: sections.untracked ?? [],
    },
    branches: [],
    stashes: [],
  }
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

  // reason: a message means nothing across two repositories, and committing
  // the wrong one is not undone by unticking.
  it('will not guess which repository a commit is for', async () => {
    const bridge = stubBridge({
      repos: [
        repo({ path: '/one', changed: [{ path: 'a.ts', status: 'M' }] }),
        repo({ path: '/two', changed: [{ path: 'b.ts', status: 'M' }] }),
      ],
    })
    await load(bridge)
    await commit('a message')
    expect(bridge.commitCalls).toEqual([])
    // Disabled rather than refused on press, and the tooltip is where a
    // disabled control in this panel says what would make it work again.
    expect((document.getElementById('commit') as HTMLButtonElement).title).toContain('2 repositories')
    // Untick one repository entirely and the other is the only candidate.
    ;(
      document.querySelectorAll('input[aria-label="Include a.ts in the next commit"]')[0] as HTMLInputElement
    ).click()
    await commit('a message')
    expect(bridge.commitCalls).toEqual([['/two', 'a message', ['b.ts'], [], []]])
  })
})
