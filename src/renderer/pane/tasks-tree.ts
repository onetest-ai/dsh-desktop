import { BOARD_STATUSES, type EntityView } from './board-rows.ts'
import { icon } from './icons.ts'
import './bridge.ts'
import type { BoardViewData, SuiteView, TestView } from './bridge.ts'
import { followHarnessTheme } from './theme.ts'

// Applies the harness's dark-mode attribute to this page; every colour here
// is a token, so nothing needs the answer itself.
followHarnessTheme(() => {})

/**
 * One element by id.
 * @param id - the element's id.
 * @returns the element, which the page always declares.
 */
function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`tasks: the page declares no #${id}`)
  return node
}

/**
 * Which rows are folded away, by folder path.
 *
 * Keyed by path rather than by position so a redraw keeps what was open: main
 * re-reads the whole board on every write an agent makes, and a tree that
 * reopened from the top on each of them would be unusable exactly while
 * something is being planned. Held in the page and never stored, for the file
 * tree's reason — it is a glance at what exists, not an arrangement worth
 * restoring into a project it may no longer describe.
 */
const collapsed = new Set<string>()

/** What the last read reported, or undefined before the first one lands. */
let latest: BoardViewData | undefined

/**
 * Why the last read answered with nothing, if it did.
 *
 * Kept beside `latest` rather than folded into it: a board that could not be
 * read is not an empty board, and wording it as one would tell the user to go
 * and plan something into a column that is broken rather than bare.
 */
let trouble: string | undefined

/**
 * Fold one path away, or open it again, and redraw.
 * @param path - the row's folder path, which is unique across the board.
 */
function toggle(path: string): void {
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
  draw()
}

/**
 * The twisty at the head of a row, turned when the row is open.
 *
 * A span rather than a button: the row itself is a button, and a button inside
 * a button is invalid markup a browser is free to take apart. Keyboard users
 * reach the same fold through the row's own arrow keys, which is what a tree
 * is expected to answer to anyway.
 * @param path - the row's folder path, or undefined for a row with no children.
 * @returns the twisty, ready to append.
 */
function twistyFor(path: string | undefined): HTMLElement {
  const twisty = document.createElement('span')
  twisty.className = 'twisty tree-twisty'
  if (path === undefined) return twisty
  twisty.append(icon(collapsed.has(path) ? 'triangleRight' : 'chevronDown', 10))
  twisty.addEventListener('click', (event) => {
    // The row's own click reveals on the board; folding must not also do that.
    event.stopPropagation()
    toggle(path)
  })
  return twisty
}

/**
 * A count beside a name, as `done/total`.
 * @param done - how many are through.
 * @param total - how many there are.
 * @returns the element, ready to append.
 */
function countTag(done: number, total: number): HTMLElement {
  const tag = document.createElement('span')
  tag.className = 'tree-count'
  tag.textContent = `${done}/${total}`
  return tag
}

/**
 * The status chip on an entity's row.
 *
 * A status the board does not draw is still shown as it reads rather than
 * being corrected here: the board files it under the first column and the
 * store reports it as a finding, and a tree that quietly renamed it would be
 * the one view claiming the file says something it does not.
 * @param status - the entity's status.
 * @returns the chip, ready to append.
 */
function statusChip(status: string): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'tree-status'
  if (!BOARD_STATUSES.includes(status)) {
    chip.classList.add('tree-status-unknown')
    chip.title = 'The board has no column for this status; it is drawn in the first one.'
  }
  chip.textContent = status
  return chip
}

/**
 * One row of the tree: a twisty, a name, and whatever counts it carries.
 *
 * Every row is a button so it is reachable by tab, and the arrow keys fold it
 * the way a tree is expected to. What the press does is the caller's, because
 * that is the whole difference between this view and the board: an entity
 * reveals, a container folds, and nothing here writes.
 * @param name - what the row is called.
 * @param path - the row's folder path, which keys its fold.
 * @param foldable - whether it has anything beneath it to fold.
 * @param press - what a click on the row does.
 * @returns the row, ready to append.
 */
function rowFor(name: string, path: string, foldable: boolean, press: () => void): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'row tree-row'
  row.append(twistyFor(foldable ? path : undefined))
  const label = document.createElement('span')
  label.className = 'name tree-name'
  label.textContent = name
  row.append(label)
  row.addEventListener('click', press)
  row.addEventListener('keydown', (event) => {
    if (!foldable) return
    const open = !collapsed.has(path)
    if (event.key === 'ArrowRight' && !open) {
      event.preventDefault()
      toggle(path)
    }
    if (event.key === 'ArrowLeft' && open) {
      event.preventDefault()
      toggle(path)
    }
  })
  return row
}

/**
 * Draw one entity and, beneath it, its children.
 *
 * Progress is shown only where there is something to be through: it is
 * computed on read and written nowhere, and it is what tells you a lane is
 * nearly done without opening it. A task, whose total is zero, shows its
 * status alone.
 * @param entity - the entity to draw.
 * @returns the list item, ready to append.
 */
function drawEntity(entity: EntityView): HTMLElement {
  const item = document.createElement('li')
  const foldable = entity.children.length > 0
  const row = rowFor(entity.name, entity.folderPath, foldable, () => {
    // The only thing a row does. Main brings the board's tab forward and
    // scrolls to the entity; this page names it and nothing else.
    window.pane.revealOnBoard(entity.folderPath)
  })
  row.append(statusChip(entity.status))
  if (entity.progress.total > 0) row.append(countTag(entity.progress.done, entity.progress.total))
  item.append(row)
  if (foldable && !collapsed.has(entity.folderPath)) {
    const children = document.createElement('ul')
    children.className = 'tree'
    for (const child of entity.children) children.append(drawEntity(child))
    item.append(children)
  }
  return item
}

/**
 * Draw one test.
 *
 * No status chip: a test has none, deliberately — it is a thing that is run,
 * not a thing that is worked on, and a chip for it would invent a state
 * nothing on disk records. What it carries instead is the count that exists
 * nowhere else: how much of what it validates holds.
 * @param test - the test to draw.
 * @returns the list item, ready to append.
 */
function drawTest(test: TestView): HTMLElement {
  const item = document.createElement('li')
  const row = rowFor(test.name, test.folderPath, false, () => {
    window.pane.revealOnBoard(test.folderPath)
  })
  if (test.validates.total > 0) row.append(countTag(test.validates.pass, test.validates.total))
  item.append(row)
  return item
}

/**
 * Whether a suite holds anything at all, at any depth.
 * @param suite - the suite to look through.
 * @returns whether there is a test anywhere beneath it.
 */
function suiteHolds(suite: SuiteView): boolean {
  return suite.tests.length > 0 || suite.suites.some(suiteHolds)
}

/**
 * Draw one suite and everything under it.
 *
 * A suite is a folder, not an entity: clicking it folds rather than revealing,
 * because there is nothing on the board for it to reveal.
 * @param suite - the suite to draw.
 * @param name - what to call it; the root is called `Tests`, the rest by slug.
 * @returns the list item, ready to append.
 */
function drawSuite(suite: SuiteView, name: string): HTMLElement {
  const item = document.createElement('li')
  const foldable = suite.suites.length > 0 || suite.tests.length > 0
  const row = rowFor(name, suite.path, foldable, () => {
    if (foldable) toggle(suite.path)
  })
  item.append(row)
  if (foldable && !collapsed.has(suite.path)) {
    const children = document.createElement('ul')
    children.className = 'tree'
    for (const child of suite.suites) children.append(drawSuite(child, child.slug))
    for (const test of suite.tests) children.append(drawTest(test))
    item.append(children)
  }
  return item
}

/**
 * Redraw the tree from the last read.
 *
 * Rebuilt whole rather than patched: the board is tens of rows, the read is
 * already the expensive half, and a fold kept in `collapsed` is the only state
 * a row carries — so there is nothing in the DOM worth preserving across one.
 */
function draw(): void {
  const into = el('tasks-tree')
  const empty = el('tasks-empty')
  const note = el('tasks-note')
  into.textContent = ''
  if (trouble !== undefined) {
    empty.textContent = trouble
    empty.hidden = false
    note.hidden = true
    return
  }
  if (latest === undefined) {
    empty.hidden = true
    note.hidden = true
    return
  }
  const board = latest
  // Named rather than counted: a file the board could not read is a row the
  // user cannot see, and silence about it looks like the row not existing.
  note.textContent = `${board.findings.length} files could not be read.`
  note.hidden = board.findings.length === 0
  if (!board.present) {
    // The one empty state with a way out of it, so it says what to do rather
    // than only what is missing.
    empty.textContent = 'This project has no board yet. Ask the agent to plan something, or create a campaign.'
    empty.hidden = false
    return
  }
  const tests = suiteHolds(board.tests)
  if (board.campaigns.length === 0 && !tests) {
    empty.textContent = 'The board is empty.'
    empty.hidden = false
    return
  }
  empty.hidden = true
  const list = document.createElement('ul')
  list.className = 'tree'
  for (const campaign of board.campaigns) list.append(drawEntity(campaign))
  // Beneath the campaigns, and only when there is one: an empty Tests root
  // would be a permanent row saying nothing on every board that has no tests.
  if (tests) list.append(drawSuite(board.tests, 'Tests'))
  into.append(list)
}

/**
 * Re-read the board and redraw.
 *
 * The only caller of the bridge's read, so every trigger costs one: main reads
 * the whole board off disk each time and never caches it, and a burst of
 * agent writes arrives here as one debounced notice.
 * @returns resolution once the tree has been redrawn.
 */
async function refresh(): Promise<void> {
  try {
    latest = await window.pane.readTasks()
    trouble = undefined
  } catch (error) {
    // Nothing on the other side of the bridge rejects today. Without this it
    // would not have to: one that did would leave `latest` unset, which draws
    // as a blank column with no message and no way to ask again.
    trouble = `The board could not be read: ${(error as Error).message}`
  }
  draw()
}

// Main says when: the project moved, or something under `.dsh/tasks/` did.
// There is no polling, and this view never asks off its own timer.
window.pane.onTasksChanged(() => {
  void refresh()
})

void refresh()
