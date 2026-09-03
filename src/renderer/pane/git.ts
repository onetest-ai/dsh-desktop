import { colourOf, parts, rowsFor, type RepoStatusView, type RowGroup } from './git-rows.ts'
import { fileIcon } from './file-icon.ts'
import { icon } from './icons.ts'
import './bridge.ts'
import { followHarnessTheme } from './theme.ts'

// Applies the harness's dark-mode attribute to this page; every colour here
// is a token, so nothing needs the answer itself.
followHarnessTheme(() => {})

/** One repository, as this page receives it over the bridge. */
interface RepoView {
  path: string
  name: string
  status: RepoStatusView
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
 * Draw one section of one repository.
 * @param repo - the repository the rows belong to.
 * @param group - the section and its entries.
 * @returns the heading and the list, ready to append.
 */
function drawSection(repo: RepoView, group: RowGroup): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const heading = document.createElement('p')
  heading.className = 'section-title'
  heading.textContent = group.title
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
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'row'

    // The same icons the file tree draws. The two views take turns in one
    // column, and a file that has an icon in one and not the other reads as
    // a different kind of thing.
    row.append(fileIcon(entry.path, false))

    const { name: filename, dir } = parts(entry)
    const name = document.createElement('span')
    name.className = 'git-name'
    name.textContent = filename
    // A deletion is said by the strike, not by the colour: colouring every
    // filename spends the one signal the list has on every row at once, and
    // a wall of amber says no more than a wall of grey.
    if (entry.status === 'D') name.classList.add('git-gone')
    row.append(name)

    if (dir !== '') {
      const where = document.createElement('span')
      where.className = 'git-dir'
      where.textContent = dir
      row.append(where)
    }

    // Last, and in the only colour the row carries — so the letters form a
    // column that can be read down without reading the names.
    const status = document.createElement('span')
    status.className = 'git-status'
    status.textContent = entry.status
    status.style.color = colourOf(entry.status)
    row.append(status)

    // The diff goes in the editor column, which is main's to fill — this page
    // only says which row was clicked and which list it was in.
    row.addEventListener('click', () => {
      window.pane.openGitDiff(repo.path, entry.path, group.section)
    })
    item.append(row)
    list.append(item)
  }
  fragment.append(list)
  return fragment
}

/**
 * Draw one repository, with a header only when it is not the only one.
 *
 * A single repository is the common case and deserves no ceremony: its name
 * and branch are a plain line above the sections rather than a control that
 * can hide the only thing on the page.
 * @param repo - the repository to draw.
 * @param alone - whether it is the only one found.
 * @returns the repository's block.
 */
function drawRepo(repo: RepoView, alone: boolean): HTMLElement {
  const block = document.createElement('section')
  block.className = 'repo'

  const groups = rowsFor(repo.status)
  const shut = !alone && collapsed.has(repo.path)

  if (alone) {
    const head = document.createElement('div')
    head.className = 'repo-head'
    head.append(branchTag(repo.status))
    block.append(head)
  } else {
    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'repo-head'
    head.setAttribute('aria-expanded', String(!shut))
    // The tree's own twisty, so the two views in this column open the same way.
    const twisty = icon(shut ? 'triangleRight' : 'chevronDown', 12)
    twisty.classList.add('repo-twisty')
    head.append(twisty)
    const name = document.createElement('span')
    name.className = 'repo-name'
    name.textContent = repo.name
    head.append(name)
    head.append(branchTag(repo.status))
    head.addEventListener('click', () => {
      if (collapsed.has(repo.path)) collapsed.delete(repo.path)
      else collapsed.add(repo.path)
      draw()
    })
    block.append(head)
  }

  if (!shut) for (const group of groups) block.append(drawSection(repo, group))
  return block
}

/** What the last read reported, or undefined before the first one lands. */
let latest: { ok: true; repos: RepoView[] } | { ok: false; reason: string } | undefined

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
  into.textContent = ''
  if (latest === undefined) {
    empty.hidden = true
    return
  }
  if (!latest.ok) {
    empty.textContent = latest.reason
    empty.hidden = false
    return
  }
  const { repos } = latest
  if (repos.length === 0) {
    empty.textContent = 'No repository in this project.'
    empty.hidden = false
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
  draw()
}

// Main says when: the project moved, the window came back, or something under
// a repo's `.git` changed. There is no polling.
window.pane.onGitChanged(() => {
  void refresh()
})

void refresh()
