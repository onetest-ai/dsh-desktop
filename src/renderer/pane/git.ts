import {
  colourOf,
  parts,
  rowsFor,
  type BranchRowView,
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
 * @param label - what it does, for the tooltip and the screen reader.
 * @param glyph - the character to show.
 * @param act - the bridge call to make.
 * @returns the button.
 */
function rowAction(label: string, glyph: string, act: () => Promise<GitResult>): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row-action'
  button.title = label
  button.setAttribute('aria-label', label)
  button.textContent = glyph
  button.addEventListener('click', () => {
    run(act)
  })
  return button
}

/**
 * Open one row's context menu and carry out what it says.
 *
 * The menu is native and lives in main, like the tree's; this only says which
 * list the row was in and acts on the answer.
 * @param repo - the repository the row belongs to.
 * @param section - which list the row is in, which decides what the menu offers.
 * @param path - the row's path within the repository.
 * @returns resolution once the chosen action has been started.
 */
async function openRowMenu(repo: RepoView, section: RowGroup['section'], path: string): Promise<void> {
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
      run(() => window.pane.unstageFiles(repo.path, one))
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
 * @param status - the repository's state.
 * @returns the element, ready to append.
 */
function branchTag(status: RepoStatusView): HTMLElement {
  const tag = document.createElement('span')
  tag.className = 'repo-branch'
  tag.append(icon('branch', 12))
  const text = document.createElement('span')
  text.textContent = branchLine(status)
  tag.append(text)
  return tag
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
  const on = paths.filter((path) => selection.ticked(repo.path, group.section, path))
  const tick = document.createElement('input')
  tick.type = 'checkbox'
  tick.className = 'git-tick'
  tick.checked = on.length === paths.length
  tick.indeterminate = on.length > 0 && on.length < paths.length
  tick.setAttribute('aria-label', `Include every file under ${group.title} in the next commit`)
  // Partly ticked counts as not ticked: pressing it fills the section, which
  // is what a header tick in that state is reached for.
  tick.addEventListener('change', () => {
    selection.setSection(repo.path, group.section, paths, on.length !== paths.length)
    draw()
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
    tick.setAttribute('aria-label', `Include ${entry.path} in the next commit`)
    tick.addEventListener('change', () => {
      selection.toggle(repo.path, group.section, entry.path)
      draw()
    })
    row.append(tick)

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'row-open'

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
    if (group.section === 'staged') {
      actions.append(rowAction('Unstage', '−', () => window.pane.unstageFiles(repo.path, one)))
    } else {
      actions.append(rowAction('Stage', '+', () => window.pane.stageFiles(repo.path, one)))
      // Untracked goes in the second list and tracked in the first: they are
      // different git commands, and the wrong one is a no-op at best.
      const tracked = group.section === 'untracked' ? [] : one
      const untracked = group.section === 'untracked' ? one : []
      actions.append(rowAction('Discard', '↺', () => window.pane.discardFiles(repo.path, tracked, untracked)))
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
      void openRowMenu(repo, group.section, entry.path)
    })
    item.append(row)
    list.append(item)
  }
  fragment.append(list)
  return fragment
}

/**
 * The three actions a repository header carries.
 *
 * Each acts on every path in the sections it applies to. Discard All names
 * the count rather than a filename in its confirmation, which main already
 * does when it is handed more than one path.
 * @param repo - the repository to act on.
 * @returns the buttons, ready to append.
 */
function repoActions(repo: RepoView): HTMLElement {
  const actions = document.createElement('span')
  actions.className = 'row-actions'
  const changed = repo.status.changed.map((entry) => entry.path)
  const untracked = repo.status.untracked.map((entry) => entry.path)
  const staged = repo.status.staged.map((entry) => entry.path)
  actions.append(
    rowAction('Stage all', '+', () => window.pane.stageFiles(repo.path, [...changed, ...untracked])),
    rowAction('Unstage all', '−', () => window.pane.unstageFiles(repo.path, staged)),
    rowAction('Discard all', '↺', () => window.pane.discardFiles(repo.path, changed, untracked)),
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
  if (alone) {
    head.append(branchTag(repo.status))
  } else {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'repo-toggle'
    toggle.setAttribute('aria-expanded', String(!shut))
    // The tree's own twisty, so the two views in this column open the same way.
    const twisty = icon(shut ? 'triangleRight' : 'chevronDown', 12)
    twisty.classList.add('repo-twisty')
    toggle.append(twisty)
    const name = document.createElement('span')
    name.className = 'repo-name'
    name.textContent = repo.name
    toggle.append(name)
    toggle.append(branchTag(repo.status))
    toggle.addEventListener('click', () => {
      if (collapsed.has(repo.path)) collapsed.delete(repo.path)
      else collapsed.add(repo.path)
      draw()
    })
    head.append(toggle)
  }
  head.append(repoActions(repo))
  block.append(head)

  if (!shut) for (const group of groups) block.append(drawSection(repo, group))
  return block
}

/** What the last read reported, or undefined before the first one lands. */
let latest: { ok: true; repos: RepoView[] } | { ok: false; reason: string } | undefined

/**
 * The repository a Commit would go to, and why there is none.
 *
 * A commit belongs to one repository. With several open, the one that has
 * ticks is the one being composed — asking which is meant when only one of
 * them has anything ticked would be a question with one possible answer.
 * Ticked in two at once is genuinely ambiguous, and is said rather than
 * guessed: committing the wrong repository is not undone by unticking.
 * @returns the repository to commit to, or the reason there is not one.
 */
function commitTarget(): { repo: RepoView } | { why: string } {
  if (latest === undefined || !latest.ok || latest.repos.length === 0) {
    return { why: 'There is no repository to commit to.' }
  }
  const ticked = latest.repos.filter((repo) => {
    const { add, keep } = selection.selected(repo.path, repo.status)
    return add.length > 0 || keep.length > 0
  })
  if (ticked.length === 0) return { why: 'Tick the files to include in the commit.' }
  if (ticked.length > 1) {
    return { why: `Files are ticked in ${ticked.length} repositories; a commit belongs to one of them.` }
  }
  return { repo: ticked[0] }
}

/**
 * Enable or disable Commit, and say in its tooltip why it is off.
 *
 * Disabled only for the two things that are simply nothing to do — no message
 * and nothing ticked — plus the ambiguous repository above. It is never
 * refused for having nothing staged: staging is what Commit does.
 */
function syncCommit(): void {
  const box = el('commit-message') as HTMLTextAreaElement
  const button = el('commit') as HTMLButtonElement
  const target = commitTarget()
  if ('why' in target) {
    button.disabled = true
    button.title = target.why
    return
  }
  const blank = box.value.trim() === ''
  button.disabled = blank
  button.title = blank ? 'Write a commit message.' : `Commit the ticked files in ${target.repo.name}`
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
  const target = commitTarget()
  if ('why' in target) {
    say(target.why)
    return
  }
  const { repo } = target
  const { add, keep } = selection.selected(repo.path, repo.status)
  say('')
  void window.pane
    .commitFiles(repo.path, box.value, add, keep, repo.status.staged.map((entry) => entry.path))
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

// Main says when: the project moved, the window came back, or something under
// a repo's `.git` changed. There is no polling.
window.pane.onGitChanged(() => {
  void refresh()
})

void refresh()
