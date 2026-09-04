import {
  colourOf,
  parts,
  rowsFor,
  type BranchRowView,
  type EntryView,
  type RepoStatusView,
  type RowGroup,
  type StashRowView,
} from './git-rows.ts'
import { Selection } from './git-select.ts'
import { fileIcon } from './file-icon.ts'
import { icon } from './icons.ts'
import './bridge.ts'
import type { GitResult } from './bridge.ts'
import { followHarnessTheme } from './theme.ts'

// Applies the harness's dark-mode attribute to this page; every colour here
// is a token, so nothing needs the answer itself.
followHarnessTheme(() => {})

/** One repository, as this page receives it over the bridge. */
interface RepoView {
  path: string
  name: string
  status: RepoStatusView
  branches: BranchRowView[]
  stashes: StashRowView[]
}

/**
 * One element by id.
 * @param id - the element's id.
 * @returns the element, which the page always declares.
 */
function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`git: the page declares no #${id}`)
  return node
}

/**
 * Which repositories are collapsed, by path.
 *
 * Held in the page and never stored: it is a glance at what changed, not a
 * workspace arrangement worth restoring, and a repo that came back collapsed
 * from a previous session would look like one with nothing in it.
 */
const collapsed = new Set<string>()

/**
 * Which files are ticked for the next commit.
 *
 * One instance for the life of the page: a tick survives every refresh, since
 * a status re-read the moment a watcher fires must not discard a selection
 * the user is in the middle of composing.
 */
const selection = new Selection()

/**
 * Which repository the commit box is aimed at, when more than one has ticks.
 *
 * Held outside the drawing so it survives a redraw the way the typed message
 * does, and cleared to whatever is still on offer by `syncCommit`.
 */
let chosenRepo: string | undefined

/**
 * Which repository's branch list is open, by path, or undefined for none.
 *
 * Held outside the drawing so a refresh a watcher asked for does not shut a
 * list the user is reading — status is re-read whenever anything under `.git`
 * moves, which on a busy repository is while the menu is open.
 */
let branchMenu: string | undefined

/** Which repository has its Fetch/Pull/Push menu open, if any. */
let syncMenu: string | undefined

/** The remote operation running in each repository, by the word for it. */
const running = new Map<string, 'Fetching' | 'Pulling' | 'Pushing' | 'Publishing'>()

/** What the running state is called for each operation. */
const DOING = {
  fetch: 'Fetching',
  pull: 'Pulling',
  push: 'Pushing',
  publish: 'Publishing',
} as const

/**
 * The inline text prompt in a repository header, and what has been typed.
 *
 * The text lives here rather than only in the element for the commit box's
 * reason: `#repos` is rebuilt by every refresh, so a name half-typed into an
 * input that a watcher redrew would otherwise be gone.
 */
let asking: { repo: string; kind: 'branch' | 'stash'; text: string } | undefined

/**
 * The switch git refused, and the files it named as being in the way.
 *
 * Kept per panel rather than per repository because only one switch is ever
 * being offered: the note is the answer to the last branch that was picked.
 */
let blocking: { repo: string; name: string; remote: boolean; files: string[]; kind: BlockedKind } | undefined

/** Which of git's two checkout refusals a block was; mirrors main's `BlockedKind`. */
type BlockedKind = 'tracked' | 'untracked'

/**
 * Every name one row occupies in the index.
 *
 * A staged rename is ONE entry with two names: `path` is where the file went
 * and `from` is where it was, and git's index holds the deletion of the old
 * name beside the addition of the new one. Unstaging or excluding only `path`
 * leaves that deletion staged, and `git commit` commits the whole index — so
 * a rename the user meant to leave out is recorded as "delete the old file",
 * with the new one left untracked. Both names travel together for that
 * reason.
 * @param entry - the row's entry.
 * @returns the path, and the original path when the entry is a rename.
 */
function namesOf(entry: EntryView): string[] {
  return entry.from === undefined ? [entry.path] : [entry.path, entry.from]
}

/**
 * How to bring each drawn checkbox back in line with the selection.
 *
 * Rebuilt by every `draw`, and run instead of one: a tick changes no layout,
 * only which boxes are filled and whether Commit is available. Redrawing
 * `#repos` for that would take the focused control out of the document, which
 * puts a keyboard user back at the top of the panel on every space bar — the
 * exact reach the row was restructured to give them.
 */
const tickUpdates: (() => void)[] = []

/**
 * A name for one control that outlives the element drawing it.
 *
 * Used to put focus back where it was after a redraw that a watcher, not the
 * user, asked for. Joined on NUL because a path may hold anything else.
 * @param repo - the repository's path.
 * @param section - the section, or the empty string for a repository header.
 * @param path - the file's path, or the empty string for a header.
 * @param what - which control on that row.
 * @returns the key.
 */
function keyOf(repo: string, section: string, path: string, what: string): string {
  return [repo, section, path, what].join('\u0000')
}

/** Run every tick updater and the commit box, without touching the layout. */
function afterTick(): void {
  for (const update of tickUpdates) update()
  syncCommit()
}

/**
 * Show why an action did not run, or clear the last such note.
 *
 * A git failure is the repo's name and the first line of stderr, decided in
 * main — never a stack trace. An empty reason clears the line rather than
 * printing nothing in a visible box: that is what main sends when the user
 * answered a confirmation with Cancel, and they already know why.
 * @param reason - what to say, or the empty string to say nothing.
 */
function say(reason: string): void {
  const note = el('git-note')
  note.textContent = reason
  note.hidden = reason === ''
}

/**
 * Run one git write and report a refusal.
 *
 * Nothing here refreshes: main notifies every panel after a write it carried
 * out, so a refresh from here would be a second read of the same state.
 * @param act - the bridge call to make.
 */
function run(act: () => Promise<GitResult>): void {
  say('')
  void act().then((out) => {
    if (!out.ok) say(out.reason)
  })
}

/**
 * One action button on a row or a repository header.
 *
 * The row's own diff-opening button is a sibling rather than an ancestor of
 * these, so an action does not also open the diff behind it and no button is
 * nested inside another — which is invalid, and which a browser is free to
 * take apart.
 * @param key - a name for the control that outlives this element, so a redraw can put focus back on it.
 * @param label - what it does, for the tooltip and the screen reader.
 * @param glyph - the character to show.
 * @param act - the bridge call to make.
 * @returns the button.
 */
function rowAction(key: string, label: string, glyph: string, act: () => Promise<GitResult>): HTMLButtonElement {
  return iconButton(key, label, glyph, () => {
    run(act)
  })
}

/**
 * One glyph button in the same shape as a row's actions.
 *
 * Separate from `rowAction` because not every one of them is a git write: the
 * header's Stash opens a prompt, and a button that answered with a promise it
 * did not have would have to lie about what `run` reports.
 * @param key - a name for the control that outlives this element, so a redraw can put focus back on it.
 * @param label - what it does, for the tooltip and the screen reader.
 * @param glyph - the character to show.
 * @param press - what to do when it is pressed.
 * @returns the button.
 */
function iconButton(key: string, label: string, glyph: string, press: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row-action'
  button.dataset.key = key
  button.title = label
  button.setAttribute('aria-label', label)
  button.textContent = glyph
  button.addEventListener('click', press)
  return button
}

/**
 * Open one row's context menu and carry out what it says.
 *
 * The menu is native and lives in main, like the tree's; this only says which
 * list the row was in and acts on the answer.
 * @param repo - the repository the row belongs to.
 * @param section - which list the row is in, which decides what the menu offers.
 * @param entry - the row's entry, whose `from` an unstage needs as well as its path.
 * @returns resolution once the chosen action has been started.
 */
async function openRowMenu(repo: RepoView, section: RowGroup['section'], entry: EntryView): Promise<void> {
  const path = entry.path
  const one = [path]
  const action = await window.pane.gitRowMenu(section)
  switch (action) {
    case 'open-diff': {
      window.pane.openGitDiff(repo.path, path, section)
      return
    }
    case 'stage': {
      run(() => window.pane.stageFiles(repo.path, one))
      return
    }
    case 'unstage': {
      // Both names of a rename, never only the new one; see `namesOf`.
      run(() => window.pane.unstageFiles(repo.path, namesOf(entry)))
      return
    }
    case 'discard': {
      // Which argument a path goes in is not cosmetic: a tracked path is
      // restored from the index and an untracked one is removed from disk,
      // and each command does nothing at all for the other kind.
      run(() =>
        window.pane.discardFiles(
          repo.path,
          section === 'untracked' ? [] : one,
          section === 'untracked' ? one : [],
        ),
      )
    }
  }
}

/**
 * How the header reads under a repository's name.
 * @param status - the repository's state.
 * @returns the branch, with its distance from the remote when there is one.
 */
function branchLine(status: RepoStatusView): string {
  const counts = [status.behind > 0 ? `↓${status.behind}` : '', status.ahead > 0 ? `↑${status.ahead}` : '']
    .filter((part) => part !== '')
    .join(' ')
  return counts === '' ? status.branch : `${status.branch}  ${counts}`
}

/**
 * The branch, with its glyph and how far it has diverged.
 *
 * The glyph does the saying: a bare word beside a repository's name reads as
 * a second name, and every list of branches anyone has seen carries one.
 * @param repo - the repository the header belongs to.
 * @returns the element, ready to append.
 */
function branchTag(repo: RepoView): HTMLElement {
  const tag = document.createElement('button')
  tag.type = 'button'
  tag.className = 'repo-branch'
  tag.dataset.key = keyOf(repo.path, '', '', 'branch')
  tag.title = `Switch branch in ${repo.name}`
  tag.setAttribute('aria-label', `Branch ${repo.status.branch}. Switch branch.`)
  tag.setAttribute('aria-expanded', String(branchMenu === repo.path))
  tag.append(icon('branch', 12))
  const text = document.createElement('span')
  text.textContent = branchLine(repo.status)
  tag.append(text)
  // A sibling of the collapse toggle, never inside it: a button within a
  // button is invalid markup, and the press would also fold the repository
  // away under the menu it just opened.
  tag.addEventListener('click', () => {
    branchMenu = branchMenu === repo.path ? undefined : repo.path
    asking = undefined
    syncMenu = undefined
    draw()
  })
  return tag
}

/**
 * Put the keyboard back on a repository's branch control.
 *
 * `draw` restores focus by `data-key` only when a control with that key is
 * still there, and every one of these paths removes the control that was
 * pressed — the branch item, the menu, the prompt — without drawing a
 * replacement. Without this, `activeElement` falls to `<body>` and a keyboard
 * user is returned to the top of the panel, which is the reach the rows were
 * restructured to give them. The branch button is where they were before the
 * list opened, and it is the nearest thing to the note or header that
 * replaced it.
 * @param repo - the repository's path.
 */
function focusBranch(repo: string): void {
  const key = keyOf(repo, '', '', 'branch')
  const button = [...el('repos').querySelectorAll<HTMLElement>('[data-key]')].find((node) => node.dataset.key === key)
  button?.focus()
}

/**
 * Switch to one branch, offering to stash when git refuses.
 *
 * Attempted rather than prevented: git carries uncommitted changes across
 * whenever they do not collide, and a panel that refused on sight would make
 * the branch list useless exactly when it is reached for — mid-change,
 * wanting to look at something else.
 * @param repo - the repository to switch.
 * @param branch - the branch that was picked, whose `remote` flag decides whether the local tracking branch is created.
 */
function pickBranch(repo: RepoView, branch: BranchRowView): void {
  say('')
  branchMenu = undefined
  blocking = undefined
  draw()
  focusBranch(repo.path)
  void window.pane.checkoutBranch(repo.path, branch.name, branch.remote).then((out) => {
    if (out.ok) return
    // With no list of files this is an ordinary failure — a ref that does not
    // resolve, a hook that refused — and there is nothing to offer to stash.
    if (out.blocked === undefined || out.blocked.length === 0) {
      say(out.reason)
      return
    }
    // `tracked` when main named no kind: it is the refusal a plain stash
    // clears, so an old main answering a new panel offers the weaker stash
    // rather than sweeping untracked files away on a guess.
    blocking = {
      repo: repo.path,
      name: branch.name,
      remote: branch.remote,
      files: out.blocked,
      kind: out.blockedKind ?? 'tracked',
    }
    draw()
  })
}

/**
 * Stash the working tree, switch, and put the stash back on the far side.
 *
 * Three writes in order, and any one of them failing stops the rest and says
 * which step it was. A half-done switch reported as success is the worst
 * outcome available here: the user would believe they are on the new branch
 * with their work restored, when they may be on the old one with the work in
 * a stash they were never told about. The pop is the step most likely to go
 * wrong — it can conflict on the far side, which leaves the stash in place
 * and the tree half-merged, and main reports that as a failure for exactly
 * this reason.
 *
 * The offer is cleared once the stash exists, whatever happens afterwards:
 * the files it names are no longer in the working tree, so leaving it up
 * would invite a second stash of nothing.
 *
 * The entry is put back by the sha the push named, not by its position. A
 * stash the push could not name stops the chain before the switch: the work
 * is safe in the list and the user is told where, which is the only honest
 * answer when there is no handle that survives another process stashing.
 *
 * `-u` is passed when what git refused over was untracked files. A plain
 * `git stash push` leaves those where they are, so without the flag the
 * chain would stash the tracked work for nothing, hit the same refusal on the
 * second checkout, and leave the user reading "your changes are stashed, but
 * the switch failed" with a stash they never asked for — or, on a repository
 * blocked by untracked files alone, "there is nothing to stash".
 * @param at - the refused switch: the repository, the branch, the files git named, and which refusal it was.
 * @returns resolution once the chain has finished or stopped.
 */
async function stashAndSwitch(at: { repo: string; name: string; remote: boolean; kind: BlockedKind }): Promise<void> {
  say('')
  const pushed = await window.pane.pushStash(at.repo, `Switching to ${at.name}`, at.kind === 'untracked')
  if (!pushed.ok) {
    say(`Nothing was switched: the stash failed. ${pushed.reason}`)
    return
  }
  blocking = undefined
  draw()
  // The sha the push answered with, never `stash@{0}`. The checkout below
  // takes anything from tens of milliseconds to seconds on a large tree, and
  // an agent stashing in the same repository during that window — this app
  // exists to have one running beside the panel, and `pull --rebase
  // --autostash` makes a real entry — would take the top of the stack. Popping
  // by position would then apply the agent's work, delete its stash, strand
  // the user's, and report a successful switch.
  const ref = pushed.ref
  if (ref === undefined) {
    say(`Your changes are stashed, but git would not name the entry, so nothing was switched. Put it back from the Stashes list.`)
    return
  }
  const again = await window.pane.checkoutBranch(at.repo, at.name, at.remote)
  if (!again.ok) {
    say(`Your changes are stashed, but the switch to ${at.name} failed. ${again.reason}`)
    return
  }
  const restored = await window.pane.applyStash(at.repo, ref, true)
  if (!restored.ok) {
    say(`Switched to ${at.name}, but your changes are still stashed: the pop failed. ${restored.reason}`)
  }
}

/** Which of the failures the panel knows how to talk about main reported. */
type TroubleKind = 'https' | 'publickey' | 'hostkey' | 'rejected' | 'no-upstream'

/**
 * The remote failure a note is up for, if any.
 *
 * One at a time and per repository: these are answered one at a time, and a
 * note about a repository that is not the one it hangs under names the wrong
 * place to go and fix it.
 */
let trouble: { repo: string; kind: TroubleKind; say: string } | undefined

/**
 * Ask a remote for one thing, and show that it is happening.
 *
 * These are the only operations in this panel that wait on something outside
 * this machine, so they are the only ones that need a state between pressed
 * and answered. Without it the panel looks idle for the seconds a fetch takes
 * and is pressed again — which main refuses, since two remote operations in
 * one working tree race for the same lock, so the second press would read as
 * the panel being broken rather than as the panel being busy.
 * @param repo - the repository to act on.
 * @param op - which operation.
 * @returns resolution once it has answered and been drawn.
 */
async function runRemote(repo: string, op: 'fetch' | 'pull' | 'push' | 'publish'): Promise<void> {
  say('')
  syncMenu = undefined
  trouble = undefined
  running.set(repo, DOING[op])
  draw()
  // The clicked sync item and the running control never share a `data-key`,
  // so `draw`'s by-key restore finds nothing here — without this the keyboard
  // falls to `<body>`. Unconditional is right for this one: the control that
  // just had focus is the one this same keypress removed, so there is nowhere
  // else the keyboard could have gone.
  focusBranch(repo)
  const out = await window.pane.gitRemote(repo, op)
  running.delete(repo)
  if (!out.ok) {
    // A trouble the panel knows gets a note with a way out of it; anything
    // else is an ordinary failure and belongs where every other one goes.
    if (out.trouble !== undefined) trouble = { repo, kind: out.trouble, say: out.reason }
    else say(out.reason)
  }
  draw()
  // This draw can land seconds after the one above, and by then the user may
  // have tabbed or clicked to an unrelated control — another repository's
  // row, the commit box, a different branch menu. Narrower than `draw`'s own
  // `asking` continuation, which leaves focus alone whenever it is anywhere
  // inside `#repos`: the commit message box sits outside `#repos`, and a
  // user typing there while a fetch finishes must not have the keyboard
  // pulled out from under them. So this only takes it back when the removed
  // control left it stranded on nothing at all.
  if (document.activeElement === null || document.activeElement === document.body) focusBranch(repo)
}

/**
 * The list a branch button opens: local branches, then remote-tracking ones.
 *
 * Drawn in the page rather than popped as a native menu, unlike the row's
 * right-click menu: this one is opened by a left click on a control that is
 * part of the panel, and it has to be reachable by tab like everything else
 * the panel added.
 * @param repo - the repository whose branches these are.
 * @returns the menu, ready to append.
 */
function branchList(repo: RepoView): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'branch-menu'
  menu.setAttribute('role', 'group')
  menu.setAttribute('aria-label', `Branches in ${repo.name}`)
  const item = (branch: BranchRowView): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'branch-item'
    button.dataset.key = keyOf(repo.path, 'branch', branch.name, 'pick')
    if (branch.current) button.classList.add('branch-current')
    const mark = document.createElement('span')
    mark.className = 'branch-mark'
    // The current branch is marked rather than left out: a list missing the
    // one you are on reads as a list that has lost it.
    mark.textContent = branch.current ? '✓' : ''
    button.append(mark)
    const name = document.createElement('span')
    name.className = 'branch-item-name'
    name.textContent = branch.name
    button.append(name)
    if (branch.upstream !== '') {
      const upstream = document.createElement('span')
      upstream.className = 'branch-upstream'
      upstream.textContent = branch.upstream
      button.append(upstream)
    }
    button.addEventListener('click', () => {
      // Switching to the branch you are on is a no-op that git reports as a
      // success, so it is not offered as one.
      if (branch.current) {
        branchMenu = undefined
        draw()
        focusBranch(repo.path)
        return
      }
      pickBranch(repo, branch)
    })
    return button
  }
  for (const branch of repo.branches.filter((one) => !one.remote)) menu.append(item(branch))
  const remotes = repo.branches.filter((one) => one.remote)
  if (remotes.length > 0) {
    const divider = document.createElement('p')
    divider.className = 'branch-divider'
    divider.textContent = 'Remote'
    menu.append(divider)
    for (const branch of remotes) menu.append(item(branch))
  }
  const make = document.createElement('button')
  make.type = 'button'
  make.className = 'branch-item branch-new'
  make.dataset.key = keyOf(repo.path, 'branch', '', 'new')
  make.textContent = 'New branch…'
  make.addEventListener('click', () => {
    branchMenu = undefined
    asking = { repo: repo.path, kind: 'branch', text: '' }
    draw()
  })
  menu.append(make)
  return menu
}

/**
 * The list the sync control opens: one operation each, never a combined Sync.
 *
 * Sync is pull-then-push, and a compound operation that half-succeeded is one
 * the panel then has to explain — usually while the user is looking at a
 * repository in a state neither half described.
 * @param repo - the repository the menu belongs to.
 * @returns the menu, ready to append.
 */
function syncList(repo: RepoView): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'branch-menu sync-menu'
  menu.setAttribute('role', 'group')
  menu.setAttribute('aria-label', `Remote operations in ${repo.name}`)
  const item = (op: 'fetch' | 'pull' | 'push', label: string, hint: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'branch-item sync-item'
    button.dataset.key = keyOf(repo.path, 'sync', op, 'pick')
    button.textContent = label
    button.title = hint
    button.addEventListener('click', () => {
      void runRemote(repo.path, op)
    })
    return button
  }
  menu.append(item('fetch', 'Fetch', 'Bring the remote branches up to date, changing nothing here'))
  menu.append(item('pull', 'Pull', 'Fetch and integrate, however your pull.rebase says to'))
  menu.append(item('push', 'Push', 'Send this branch to its upstream'))
  return menu
}

/**
 * What the header shows instead of its controls while a remote runs.
 * @param repo - the repository.
 * @param doing - the word for what is happening.
 * @returns the line, ready to append.
 */
function runningNote(repo: RepoView, doing: string): HTMLElement {
  const line = document.createElement('span')
  line.className = 'sync-running'
  const text = document.createElement('span')
  text.className = 'sync-running-text'
  text.textContent = `${doing}…`
  line.append(text)
  const stop = document.createElement('button')
  stop.type = 'button'
  stop.className = 'row-action sync-cancel'
  stop.dataset.key = keyOf(repo.path, '', '', 'cancel-remote')
  stop.title = `Stop ${doing.toLowerCase()} in ${repo.name}`
  stop.setAttribute('aria-label', `Stop ${doing.toLowerCase()} in ${repo.name}`)
  stop.textContent = '×'
  // Kills the child rather than only hiding the spinner: an operation that
  // was going nowhere is still going nowhere with the spinner gone.
  stop.addEventListener('click', () => {
    window.pane.cancelGitRemote(repo.path)
  })
  line.append(stop)
  return line
}

/**
 * The header's inline text prompt, for a new branch or a stash message.
 *
 * Commits on Enter and cancels on Escape, in the header's own place rather
 * than in a dialog: naming a branch is one field, and a modal for one field
 * is a modal that has to be dismissed before the list it came from can be
 * read again.
 * @param repo - the repository the prompt belongs to.
 * @param kind - which prompt it is, which decides what Enter runs.
 * @returns the input, ready to append.
 */
function promptFor(repo: RepoView, kind: 'branch' | 'stash'): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'branch-input'
  input.dataset.key = keyOf(repo.path, '', '', `ask-${kind}`)
  input.value = asking?.text ?? ''
  const label = kind === 'branch' ? 'New branch name' : 'Stash message'
  input.placeholder = kind === 'branch' ? 'Branch name' : 'Message (optional)'
  input.setAttribute('aria-label', `${label} for ${repo.name}`)
  input.addEventListener('input', () => {
    if (asking !== undefined) asking.text = input.value
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      asking = undefined
      draw()
      focusBranch(repo.path)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const text = input.value
    asking = undefined
    draw()
    focusBranch(repo.path)
    // A blank branch name is refused by main, which owns git's own naming
    // rules; a blank stash message is allowed, because the message is
    // optional and git writes its own `WIP on …` when there is none.
    if (kind === 'branch') run(() => window.pane.createBranch(repo.path, text))
    else run(() => window.pane.pushStash(repo.path, text))
  })
  return input
}

/**
 * The note shown when git refused a switch, carrying the offer to stash.
 * @param at - the refused switch and the files git named.
 * @returns the note, ready to append.
 */
function blockedNote(at: {
  repo: string
  name: string
  remote: boolean
  files: string[]
  kind: BlockedKind
}): HTMLElement {
  const note = document.createElement('div')
  note.className = 'branch-blocked'
  const text = document.createElement('p')
  text.className = 'branch-blocked-text'
  // The files are the content of the offer: an offer that cannot say what it
  // would stash is a shrug with a button on it. The untracked wording is not
  // decoration either — stashing those takes files git has never seen out of
  // the working tree, which is a bigger thing than stashing edits and has to
  // be said before the button is pressed.
  const what = at.files.join(', ')
  text.textContent =
    at.kind === 'untracked'
      ? `Switching to ${at.name} would overwrite the untracked files ${what}. Stashing takes them with it.`
      : `Switching to ${at.name} would overwrite ${what}.`
  note.append(text)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'branch-blocked-button'
  button.dataset.key = keyOf(at.repo, 'branch', at.name, 'stash-and-switch')
  button.textContent = 'Stash and switch'
  // A button, never automatic: an automatic stash-and-pop churns the stash on
  // switches that never needed one, and a pop can conflict on the far side.
  button.addEventListener('click', () => {
    void stashAndSwitch(at)
  })
  note.append(button)
  return note
}

/**
 * The note shown when a remote refused for a reason the panel recognises.
 *
 * Every one of these names the repository and offers the terminal: run it
 * once by hand, let git's own credential helper cache what it needs, and the
 * panel works from then on. That escape hatch is what makes this app's having
 * no askpass of its own acceptable rather than merely principled — a
 * credential it never sees is one it cannot leak, and the cost is a shell.
 * @param at - the repository, which trouble it was, and the sentence for it.
 * @param name - the repository's display name.
 * @returns the note, ready to append.
 */
function troubleNote(at: { repo: string; kind: TroubleKind; say: string }, name: string): HTMLElement {
  const note = document.createElement('div')
  note.className = 'branch-blocked sync-trouble'
  const text = document.createElement('p')
  text.className = 'branch-blocked-text'
  text.textContent = `${name}: ${at.say}`
  note.append(text)
  // The one trouble with an answer inside the panel. Publishing is
  // `--set-upstream` to the only remote there is, which is what anyone
  // pushing a new branch for the first time means by it; main refuses to
  // guess when there is more than one.
  if (at.kind === 'no-upstream') {
    const publish = document.createElement('button')
    publish.type = 'button'
    publish.className = 'branch-blocked-button sync-trouble-publish'
    publish.dataset.key = keyOf(at.repo, 'sync', '', 'publish')
    publish.textContent = 'Publish branch'
    publish.addEventListener('click', () => {
      void runRemote(at.repo, 'publish')
    })
    note.append(publish)
  }
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'branch-blocked-button sync-trouble-terminal'
  open.dataset.key = keyOf(at.repo, 'sync', '', 'terminal')
  open.textContent = 'Open in Terminal'
  open.addEventListener('click', () => {
    window.pane.openGitTerminal(at.repo)
  })
  note.append(open)
  return note
}

/**
 * The Stashes section, drawn only when the repository has one.
 *
 * Below the file sections: a stash is what is not in the working tree, and
 * putting it above the files that are would read as part of them.
 * @param repo - the repository whose stashes these are.
 * @returns the heading and the list, ready to append.
 */
function drawStashes(repo: RepoView): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const heading = document.createElement('p')
  heading.className = 'section-title'
  const title = document.createElement('span')
  title.textContent = 'Stashes'
  heading.append(title)
  const count = document.createElement('span')
  count.className = 'section-count'
  count.textContent = String(repo.stashes.length)
  heading.append(count)
  fragment.append(heading)

  const list = document.createElement('ul')
  list.className = 'git-rows'
  for (const stash of repo.stashes) {
    const item = document.createElement('li')
    const row = document.createElement('div')
    row.className = 'row stash-row'

    const message = document.createElement('span')
    message.className = 'git-name stash-message'
    // A stash git named for itself still has a ref, which is the only handle
    // the user has on it.
    message.textContent = stash.message === '' ? stash.ref : stash.message
    row.append(message)

    const where = document.createElement('span')
    where.className = 'git-dir'
    where.textContent = stash.branch
    row.append(where)

    const actions = document.createElement('span')
    actions.className = 'row-actions'
    const at = (what: string): string => keyOf(repo.path, 'stash', stash.sha, what)
    // Labelled by position, acting by sha. The position is what the user is
    // looking at; the sha is what survives another process stashing between
    // the click and the command — and, for Drop, the whole time a native
    // confirmation stands open. Main re-resolves the sha and refuses one that
    // has left the list rather than falling back to a position.
    actions.append(
      rowAction(at('apply'), `Apply ${stash.ref}`, '⇡', () => window.pane.applyStash(repo.path, stash.sha, false)),
    )
    actions.append(
      rowAction(at('pop'), `Pop ${stash.ref}`, '⤒', () => window.pane.applyStash(repo.path, stash.sha, true)),
    )
    // Unrecoverable in the way Discard is, and confirmed in main for the same
    // reason: a dropped stash is reachable only by a hash never shown here.
    actions.append(rowAction(at('drop'), `Drop ${stash.ref}`, '✕', () => window.pane.dropStash(repo.path, stash.sha)))
    row.append(actions)

    item.append(row)
    list.append(item)
  }
  fragment.append(list)
  return fragment
}

/**
 * The tick that governs one whole section.
 *
 * `indeterminate` rather than a third state of its own: some-but-not-all is
 * what the platform's own checkbox already means by it, and inventing a
 * glyph for it here would be the only one of its kind on the machine.
 * @param repo - the repository the section belongs to.
 * @param group - the section and its entries.
 * @returns the checkbox, ready to append.
 */
function sectionTick(repo: RepoView, group: RowGroup): HTMLInputElement {
  const paths = group.entries.map((entry) => entry.path)
  const on = (): string[] => paths.filter((path) => selection.ticked(repo.path, group.section, path))
  const tick = document.createElement('input')
  tick.type = 'checkbox'
  tick.className = 'git-tick'
  tick.dataset.key = keyOf(repo.path, group.section, '', 'section-tick')
  tick.setAttribute('aria-label', `Include every file under ${group.title} in the next commit`)
  const update = (): void => {
    const count = on().length
    tick.checked = count === paths.length
    tick.indeterminate = count > 0 && count < paths.length
  }
  update()
  tickUpdates.push(update)
  // Partly ticked counts as not ticked: pressing it fills the section, which
  // is what a header tick in that state is reached for.
  tick.addEventListener('change', () => {
    selection.setSection(repo.path, group.section, paths, on().length !== paths.length)
    afterTick()
  })
  return tick
}

/**
 * Draw one section of one repository.
 * @param repo - the repository the rows belong to.
 * @param group - the section and its entries.
 * @returns the heading and the list, ready to append.
 */
function drawSection(repo: RepoView, group: RowGroup): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const heading = document.createElement('p')
  heading.className = 'section-title'
  heading.append(sectionTick(repo, group))
  const title = document.createElement('span')
  title.textContent = group.title
  heading.append(title)
  // How big the job is, without counting the rows.
  const count = document.createElement('span')
  count.className = 'section-count'
  count.textContent = String(group.entries.length)
  heading.append(count)
  fragment.append(heading)

  const list = document.createElement('ul')
  list.className = 'git-rows'
  for (const entry of group.entries) {
    const item = document.createElement('li')
    // A container rather than the clickable thing itself: the tick and the
    // actions sit beside the button that opens the diff, not inside it.
    const row = document.createElement('div')
    row.className = 'row'

    const tick = document.createElement('input')
    tick.type = 'checkbox'
    tick.className = 'git-tick'
    // Keyed by section as well as by path: a file staged and then edited
    // again has a row in two sections that mean different content, and one
    // tick answering for both would commit the wrong one.
    tick.checked = selection.ticked(repo.path, group.section, entry.path)
    tick.dataset.key = keyOf(repo.path, group.section, entry.path, 'tick')
    tick.setAttribute('aria-label', `Include ${entry.path} in the next commit`)
    tickUpdates.push(() => {
      tick.checked = selection.ticked(repo.path, group.section, entry.path)
    })
    tick.addEventListener('change', () => {
      selection.toggle(repo.path, group.section, entry.path)
      afterTick()
    })
    row.append(tick)

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'row-open'
    open.dataset.key = keyOf(repo.path, group.section, entry.path, 'open')

    // The same icons the file tree draws. The two views take turns in one
    // column, and a file that has an icon in one and not the other reads as
    // a different kind of thing.
    open.append(fileIcon(entry.path, false))

    const { name: filename, dir } = parts(entry)
    const name = document.createElement('span')
    name.className = 'git-name'
    name.textContent = filename
    // A deletion is said by the strike, not by the colour: colouring every
    // filename spends the one signal the list has on every row at once, and
    // a wall of amber says no more than a wall of grey.
    if (entry.status === 'D') name.classList.add('git-gone')
    open.append(name)

    if (dir !== '') {
      const where = document.createElement('span')
      where.className = 'git-dir'
      where.textContent = dir
      open.append(where)
    }

    // The diff goes in the editor column, which is main's to fill — this page
    // only says which row was clicked and which list it was in.
    open.addEventListener('click', () => {
      window.pane.openGitDiff(repo.path, entry.path, group.section)
    })
    row.append(open)

    // Hidden until hover or focus, so the list reads as filenames rather than
    // as a wall of glyphs; reachable by tab either way.
    const actions = document.createElement('span')
    actions.className = 'row-actions'
    const one = [entry.path]
    const at = (what: string): string => keyOf(repo.path, group.section, entry.path, what)
    if (group.section === 'staged') {
      // Both names of a rename, never only the new one; see `namesOf`.
      actions.append(rowAction(at('unstage'), 'Unstage', '−', () => window.pane.unstageFiles(repo.path, namesOf(entry))))
    } else {
      actions.append(rowAction(at('stage'), 'Stage', '+', () => window.pane.stageFiles(repo.path, one)))
      // Untracked goes in the second list and tracked in the first: they are
      // different git commands, and the wrong one is a no-op at best.
      const tracked = group.section === 'untracked' ? [] : one
      const untracked = group.section === 'untracked' ? one : []
      actions.append(
        rowAction(at('discard'), 'Discard', '↺', () => window.pane.discardFiles(repo.path, tracked, untracked)),
      )
    }
    row.append(actions)

    // Last, and in the only colour the row carries — so the letters form a
    // column that can be read down without reading the names.
    const status = document.createElement('span')
    status.className = 'git-status'
    status.textContent = entry.status
    status.style.color = colourOf(entry.status)
    row.append(status)

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      void openRowMenu(repo, group.section, entry)
    })
    item.append(row)
    list.append(item)
  }
  fragment.append(list)
  return fragment
}

/**
 * The actions a repository header carries, for the lists it actually has.
 *
 * Each acts on every path in the sections it applies to. Discard All names
 * the count rather than a filename in its confirmation, which main already
 * does when it is handed more than one path.
 *
 * An action whose lists are empty is left out rather than drawn dead: on a
 * clean repository Discard All would otherwise raise a native warning asking
 * to discard nothing, which teaches the user to dismiss the one dialog in the
 * panel that must never be dismissed out of habit.
 * @param repo - the repository to act on.
 * @returns the buttons, ready to append.
 */
function repoActions(repo: RepoView): HTMLElement {
  const actions = document.createElement('span')
  actions.className = 'row-actions'
  const changed = repo.status.changed.map((entry) => entry.path)
  const untracked = repo.status.untracked.map((entry) => entry.path)
  // Both names of every staged rename; see `namesOf`.
  const staged = repo.status.staged.flatMap(namesOf)
  const at = (what: string): string => keyOf(repo.path, '', '', what)
  if (changed.length + untracked.length > 0) {
    actions.append(
      rowAction(at('stage-all'), 'Stage all', '+', () =>
        window.pane.stageFiles(repo.path, [...changed, ...untracked]),
      ),
    )
  }
  if (staged.length > 0) {
    actions.append(rowAction(at('unstage-all'), 'Unstage all', '−', () => window.pane.unstageFiles(repo.path, staged)))
  }
  if (changed.length + untracked.length > 0) {
    actions.append(
      rowAction(at('discard-all'), 'Discard all', '↺', () =>
        window.pane.discardFiles(repo.path, changed, untracked),
      ),
    )
  }
  // Stash takes the working tree, so it is offered only when there is one to
  // take: `git stash push` leaves untracked files alone, and on a repository
  // whose only changes are untracked it would report having stashed nothing.
  if (staged.length + changed.length > 0) {
    actions.append(
      iconButton(at('stash'), 'Stash', '⇣', () => {
        branchMenu = undefined
        asking = { repo: repo.path, kind: 'stash', text: '' }
        draw()
      }),
    )
  }
  // While one is running the header shows that instead of the control: main
  // refuses a second operation in the same repository, so a menu that could
  // still be opened would only offer a refusal.
  const doing = running.get(repo.path)
  if (doing !== undefined) {
    actions.append(runningNote(repo, doing))
    return actions
  }
  actions.append(
    iconButton(at('sync'), 'Fetch, pull or push', '⇅', () => {
      branchMenu = undefined
      syncMenu = syncMenu === repo.path ? undefined : repo.path
      draw()
    }),
  )
  return actions
}

/**
 * Draw one repository, with a header only when it is not the only one.
 *
 * A single repository is the common case and deserves no ceremony: its name
 * and branch are a plain line above the sections rather than a control that
 * can hide the only thing on the page. The header is a container either way,
 * since the per-repo actions sit beside the part that collapses it rather
 * than inside it.
 * @param repo - the repository to draw.
 * @param alone - whether it is the only one found.
 * @returns the repository's block.
 */
function drawRepo(repo: RepoView, alone: boolean): HTMLElement {
  const block = document.createElement('section')
  block.className = 'repo'

  const groups = rowsFor(repo.status)
  const shut = !alone && collapsed.has(repo.path)

  const head = document.createElement('div')
  head.className = 'repo-head'
  // The prompt takes the header's place rather than sitting beside it: one
  // field needs no dialog, and the header is where the control that opened it
  // was, so the eye does not have to go looking.
  if (asking?.repo === repo.path) {
    head.append(promptFor(repo, asking.kind))
  } else {
    if (!alone) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'repo-toggle'
      toggle.dataset.key = keyOf(repo.path, '', '', 'toggle')
      toggle.setAttribute('aria-expanded', String(!shut))
      // The tree's own twisty, so the two views in this column open the same way.
      const twisty = icon(shut ? 'triangleRight' : 'chevronDown', 12)
      twisty.classList.add('repo-twisty')
      toggle.append(twisty)
      const name = document.createElement('span')
      name.className = 'repo-name'
      name.textContent = repo.name
      toggle.append(name)
      toggle.addEventListener('click', () => {
        if (collapsed.has(repo.path)) collapsed.delete(repo.path)
        else collapsed.add(repo.path)
        draw()
      })
      head.append(toggle)
    }
    // The branch is a control now, so it is a sibling of the toggle rather
    // than part of it — nesting it would be a button inside a button.
    head.append(branchTag(repo))
    head.append(repoActions(repo))
  }
  block.append(head)

  // Both of these hang under the header rather than inside it: the header is
  // one line, and neither the list nor the note fits on it.
  if (branchMenu === repo.path && asking === undefined) block.append(branchList(repo))
  if (syncMenu === repo.path && asking === undefined) block.append(syncList(repo))
  if ((branchMenu === repo.path || syncMenu === repo.path) && asking === undefined) {
    // Bound on the whole repository rather than on the list: opening the menu
    // leaves the keyboard on the branch button, which is outside it, so a
    // handler on the list itself would do nothing until the user had tabbed
    // into it — and tabbing in is the thing Escape is there to avoid.
    block.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      branchMenu = undefined
      syncMenu = undefined
      draw()
      focusBranch(repo.path)
    })
  }
  if (blocking?.repo === repo.path) block.append(blockedNote(blocking))
  if (trouble?.repo === repo.path) block.append(troubleNote(trouble, repo.name))

  if (!shut) {
    for (const group of groups) block.append(drawSection(repo, group))
    if (repo.stashes.length > 0) block.append(drawStashes(repo))
  }
  return block
}

/** What the last read reported, or undefined before the first one lands. */
let latest: { ok: true; repos: RepoView[] } | { ok: false; reason: string } | undefined

/**
 * The repositories that have anything ticked, in the order they are drawn.
 *
 * Committing acts on one of these. A repository with nothing ticked is not a
 * candidate at all: there would be nothing for the commit to contain.
 * @returns the repositories a Commit could go to.
 */
function commitCandidates(): RepoView[] {
  if (latest === undefined || !latest.ok) return []
  return latest.repos.filter((repo) => {
    const { add, keep } = selection.selected(repo.path, repo.status)
    return add.length > 0 || keep.length > 0
  })
}

/**
 * The repository a Commit would go to.
 *
 * A commit belongs to one repository, and with several ticked the user picks
 * it from the selector rather than the panel inferring it. Inferring it was
 * worse than it looks: tracked changes arrive ticked, so a project holding
 * two dirty checkouts — the case the repo scan exists for — would open unable
 * to commit at all, saying so only in the tooltip of a disabled button.
 * @returns the repository to commit to, or undefined when nothing is ticked.
 */
function commitTarget(): RepoView | undefined {
  const candidates = commitCandidates()
  return candidates.find((repo) => repo.path === chosenRepo) ?? candidates[0]
}

/**
 * Show the repository selector when the choice is real, and keep its value.
 *
 * Absent with one candidate: a control with one option is a control that only
 * takes up room. The chosen path survives a redraw, and falls back to the
 * first candidate when the repository it named no longer has anything ticked.
 *
 * The options are rebuilt only when they do not already match, so a native
 * dropdown the user has open is not torn out from under them by a refresh a
 * watcher asked for. What they are compared against is the `<select>`'s own
 * options rather than a note kept beside it: a note has to be invalidated
 * everywhere the options are cleared, and the one place that was missed —
 * emptying the list when the second repository stopped being a candidate —
 * left the marker claiming a list that was no longer there, so re-ticking
 * that file showed the selector with nothing in it. A comparison derived
 * from the element cannot go stale, because there is nothing to keep in step.
 * @param candidates - the repositories that have something ticked.
 */
function syncRepoChoice(candidates: RepoView[]): void {
  const row = el('commit-repo-row')
  const picker = el('commit-repo') as HTMLSelectElement
  row.hidden = candidates.length < 2
  if (candidates.length < 2) {
    picker.textContent = ''
    return
  }
  if (!candidates.some((repo) => repo.path === chosenRepo)) chosenRepo = candidates[0].path
  const wanted = candidates.map((repo) => repo.path)
  const shown = [...picker.options].map((option) => option.value)
  if (shown.length !== wanted.length || shown.some((path, at) => path !== wanted[at])) {
    picker.textContent = ''
    for (const repo of candidates) {
      const option = document.createElement('option')
      option.value = repo.path
      option.textContent = repo.name
      picker.append(option)
    }
  }
  picker.value = chosenRepo ?? ''
}

/**
 * Enable or disable Commit, and say in its tooltip why it is off.
 *
 * Disabled only for the two things that are simply nothing to do: no message,
 * and nothing ticked in the repository it would go to. It is never refused
 * for having nothing staged — staging is what Commit does.
 */
function syncCommit(): void {
  const box = el('commit-message') as HTMLTextAreaElement
  const button = el('commit') as HTMLButtonElement
  const candidates = commitCandidates()
  syncRepoChoice(candidates)
  const target = commitTarget()
  if (target === undefined) {
    button.disabled = true
    button.title = 'Tick the files to include in the commit.'
    return
  }
  const blank = box.value.trim() === ''
  button.disabled = blank
  button.title = blank ? 'Write a commit message.' : `Commit the ticked files in ${target.name}`
}

/**
 * Redraw the panel from the last read.
 *
 * The three states with nothing to show are worded rather than left blank:
 * none of them is a failure, and the one that is fixable names the setting
 * that fixes it.
 */
function draw(): void {
  const empty = el('git-empty')
  const into = el('repos')
  const form = el('commit-form')
  // Which control had focus, if any: a refresh a watcher asked for must not
  // move the keyboard back to the top of the panel while the user is on a row.
  const active = document.activeElement
  const focused = active instanceof HTMLElement && into.contains(active) ? active.dataset.key : undefined
  tickUpdates.length = 0
  into.textContent = ''
  if (latest === undefined) {
    empty.hidden = true
    form.hidden = true
    return
  }
  if (!latest.ok) {
    empty.textContent = latest.reason
    empty.hidden = false
    form.hidden = true
    return
  }
  const { repos } = latest
  // No repository is not a state a commit box belongs in; a clean one is,
  // since a file can change under it at any moment.
  form.hidden = repos.length === 0
  if (repos.length === 0) {
    empty.textContent = 'No repository in this project.'
    empty.hidden = false
    syncCommit()
    return
  }
  const anything = repos.some((repo) => rowsFor(repo.status).length > 0)
  if (!anything) {
    empty.textContent = 'Nothing has changed.'
    empty.hidden = false
    // The branch is still worth showing: a clean repository is a state, and
    // which branch it is clean on is the thing being checked.
  } else {
    empty.hidden = true
  }
  const alone = repos.length === 1
  for (const repo of repos) into.append(drawRepo(repo, alone))
  // By key rather than by selector: a path can hold any character a CSS
  // attribute selector would have to be escaped for.
  if (focused !== undefined) {
    const again = [...into.querySelectorAll<HTMLElement>('[data-key]')].find((node) => node.dataset.key === focused)
    again?.focus()
  }
  // A prompt that has just replaced a header is typed into immediately or it
  // is nothing but a gap where the branch used to be. Only when nothing in
  // the panel already has the keyboard, so a redraw a watcher asked for does
  // not take focus off whatever the user moved to.
  if (asking !== undefined) {
    const box = into.querySelector<HTMLInputElement>('.branch-input')
    if (box !== null && !into.contains(document.activeElement)) box.focus()
  }
  syncCommit()
}

/**
 * Re-read the project's repositories and redraw.
 *
 * Every trigger goes through here rather than each drawing its own answer:
 * main serialises the read, so a burst of them costs one git.
 * @returns resolution once the panel has been redrawn.
 */
async function refresh(): Promise<void> {
  try {
    latest = await window.pane.readGit()
  } catch (error) {
    // Nothing on the other side of the bridge rejects today. Without this it
    // would not have to: one that did would leave `latest` unset, which draws
    // as a blank panel with no message and no way to ask again.
    latest = { ok: false, reason: `Source control could not be read: ${(error as Error).message}` }
  }
  // Before the draw, so a path that has only just appeared is drawn with the
  // default its section gives it rather than unticked for one frame.
  if (latest.ok) for (const repo of latest.repos) selection.reconcile(repo.path, repo.status)
  draw()
}

// Committing stages for you: `add` is what is ticked and not yet in the
// index, `keep` is what is ticked and already in it, and `staged` is what the
// index holds so main can reset whatever was unticked. The two lists are not
// interchangeable — a path that is staged and then edited again is in both
// sections at once, and putting its staged tick through `git add` would
// replace the recorded version with the newer edits that tick exists to keep
// out of this commit.
el('commit-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const box = el('commit-message') as HTMLTextAreaElement
  const repo = commitTarget()
  if (repo === undefined) return
  const { add, keep } = selection.selected(repo.path, repo.status)
  say('')
  void window.pane
    .commitFiles(repo.path, box.value, add, keep, repo.status.staged.flatMap(namesOf))
    .then((out) => {
      // Cleared only on success: a message the user typed is not thrown away
      // because git refused the commit it was written for.
      if (out.ok) box.value = ''
      else say(out.reason)
      syncCommit()
    })
})

// The button turns on and off with what is typed, not only with what is drawn.
el('commit-message').addEventListener('input', syncCommit)

// Which repository the commit goes to. Kept in a variable rather than read
// off the element, so it survives the redraw that follows the next refresh.
el('commit-repo').addEventListener('change', (event) => {
  chosenRepo = (event.target as HTMLSelectElement).value
  syncCommit()
})

// Main says when: the project moved, the window came back, or something under
// a repo's `.git` changed. There is no polling.
window.pane.onGitChanged(() => {
  void refresh()
})

void refresh()
