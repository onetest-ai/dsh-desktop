import { type DetailActions, renderDetail } from './board-detail.ts'
import { BOARD_STATUSES, chipOf, groupBoard, type EntityView, type LaneView } from './board-rows.ts'
import './bridge.ts'
import type { BoardViewData, EntityDetailView } from './bridge.ts'
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
  if (node === null) throw new Error(`board: the page declares no #${id}`)
  return node
}

/** What the last read reported, or undefined before the first one lands. */
let latest: BoardViewData | undefined

/**
 * Why the last read answered with nothing, if it did.
 *
 * Kept beside `latest` for the tree's reason: a board that could not be read
 * is not an empty board, and wording it as one would invite someone to plan
 * work into columns that are broken rather than bare.
 */
let trouble: string | undefined

/**
 * Why the last write did not happen, if it did not.
 *
 * Held across the redraw that follows it, because the redraw is exactly what
 * undoes the gesture: the card goes back where the file says it is, and this
 * is the only thing left saying why it moved back.
 */
let refusal: string | undefined

/**
 * The folder path main last asked to be shown, so a redraw keeps it marked.
 *
 * One string for all four kinds of row the tree draws, because that is all
 * main sends. What it names is decided while drawing, against the board that
 * is being drawn: a campaign heading, a mission's lane, or one card. A bug
 * lane carries its campaign's own folder path, so the two cannot be told
 * apart by the string alone — the campaign is matched on its heading and the
 * lane only when it is a mission's, which is what keeps a campaign's click
 * off the Bugs lane beneath it.
 */
let revealed: string | undefined

/**
 * The entity whose detail is on screen, or undefined when the columns are.
 *
 * The whole detail rather than the folder path it was opened from: it is what
 * `draw` renders, and holding only the path would mean either a read inside
 * `draw` — which is synchronous and called from every redraw — or a second
 * copy of the entity kept somewhere else. Re-read in `refresh` alongside the
 * board, from the same walk of the same files, so the detail and the card it
 * was opened from cannot disagree.
 *
 * Not remembered across a session, and cleared with the project: a panel that
 * reopened on the task you were reading last Tuesday has decided something
 * for you.
 */
let detail: EntityDetailView | undefined

/** What the modal is about to create, or undefined when it is closed. */
let pending: { level: 'task' | 'bug'; parent: string } | undefined

/**
 * A small dimmed tag on a card.
 * @param className - what kind of tag it is, for the stylesheet.
 * @param text - what it says.
 * @returns the tag, ready to append.
 */
function tag(className: string, text: string): HTMLElement {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

/**
 * Move one card to a status, and say so when the store would not.
 *
 * Called from `drop` and from nowhere else. Nothing is moved before the
 * answer comes back: the card is where the file says it is until the file
 * says something different, so a refusal needs no undo — the redraw is one.
 * @param folderPath - the card that was dropped.
 * @param status - the column it landed in.
 * @returns resolution once the answer has been drawn.
 */
async function move(folderPath: string, status: string): Promise<void> {
  const out = await window.pane.setBoardStatus(folderPath, status)
  refusal = out.ok ? undefined : out.reason
  draw()
}

/**
 * Move one entity to the board's trash, and say so when the store would not.
 *
 * Main asks first, the way Discard in the git panel does, and this page never
 * asks a second time: two confirmations for one press teach a user to click
 * through both.
 * @param folderPath - the entity to trash.
 * @param name - what the card calls it, which is what the prompt should say.
 * @returns resolution once the answer has been drawn.
 */
async function trash(folderPath: string, name: string): Promise<void> {
  const out = await window.pane.trashBoardEntity(folderPath, name)
  refusal = out.ok ? undefined : out.reason
  draw()
}

/**
 * One card: a button that opens the entity's detail and can be dragged.
 *
 * A button so it is reachable by tab and pressed by Enter, and `draggable`
 * on top of that rather than instead of it — the drag is the quick way to a
 * status, never the only way to reach the card.
 * @param entity - the entity to draw.
 * @returns the card and its delete control, ready to append.
 */
function cardFor(entity: EntityView): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'board-card-wrap'
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'board-card'
  card.draggable = true
  card.dataset.folder = entity.folderPath
  const name = document.createElement('span')
  name.className = 'board-card-name'
  name.textContent = entity.name
  card.append(name)
  if (entity.level === 'bug') card.append(tag('board-card-kind', 'bug'))
  if (entity.criteria.total > 0) {
    card.append(tag('board-card-criteria', `${String(entity.criteria.done)}/${String(entity.criteria.total)}`))
  }
  // The tree reveals a task or a bug as its own card: a lane of thirty cards
  // highlighted whole is the hunt the reveal was meant to end.
  if (entity.folderPath === revealed) card.classList.add('board-card-revealed')
  const chip = chipOf(entity)
  if (chip !== undefined) {
    const node = tag('board-chip', chip.text)
    if (chip.failing) node.classList.add('board-chip-failing')
    card.append(node)
  }
  card.addEventListener('click', () => {
    // The detail, not the file. The file is a document now and worth opening,
    // but opening it is still a detour when all that was wanted was to see
    // the thing that was clicked — Open file inside the detail is that door.
    void openDetail(entity.folderPath)
  })
  card.addEventListener('dragstart', (event) => {
    // The path and nothing else: what a drop means is decided by the column
    // it lands in, which the card cannot know while it is in the air.
    const transfer = (event as DragEvent).dataTransfer
    if (transfer === null || transfer === undefined) return
    transfer.setData('text/plain', entity.folderPath)
    transfer.effectAllowed = 'move'
  })

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'board-card-delete'
  remove.textContent = '✕'
  remove.title = 'Move to the board’s trash'
  remove.setAttribute('aria-label', `Delete ${entity.name}`)
  // Hidden until asked for, and a sibling of the card rather than a child of
  // it: a button inside a button is invalid markup a browser may take apart,
  // and every press on it would also open the card's detail.
  remove.hidden = true
  remove.addEventListener('click', () => {
    void trash(entity.folderPath, entity.name)
  })
  wrap.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    remove.hidden = false
  })
  wrap.append(card, remove)
  return wrap
}

/**
 * One column of one lane, holding the cards whose status names it.
 *
 * The drop is where the write happens, and `dragover` does nothing but allow
 * it. A status written while a card is merely passing over a column would be
 * a status nobody chose, once for every column crossed, in someone's own
 * repository.
 * @param status - the status the column stands for.
 * @param cards - the entities in it, which may be none.
 * @returns the column, ready to append.
 */
function columnFor(status: string, cards: EntityView[]): HTMLElement {
  const column = document.createElement('div')
  column.className = `board-column board-column-${status}`
  const title = document.createElement('p')
  title.className = 'board-column-title'
  title.textContent = status
  column.append(title)
  for (const card of cards) column.append(cardFor(card))
  column.addEventListener('dragover', (event) => {
    // Without this the browser refuses the drop, and nothing lands anywhere.
    event.preventDefault()
  })
  column.addEventListener('drop', (event) => {
    event.preventDefault()
    const folderPath = (event as DragEvent).dataTransfer?.getData('text/plain') ?? ''
    if (folderPath === '') return
    void move(folderPath, status)
  })
  return column
}

/**
 * One lane: a mission, or a campaign's own bugs, and its six columns.
 *
 * The lane's plus creates into the lane itself, which is what makes the
 * button unambiguous — there is no picker asking where the new thing goes,
 * because the row it was pressed on already said.
 * @param lane - the lane to draw.
 * @returns the lane, ready to append.
 */
function laneFor(lane: LaneView): HTMLElement {
  const row = document.createElement('section')
  row.className = 'board-lane'
  row.dataset.folder = lane.folderPath
  const head = document.createElement('div')
  head.className = 'board-lane-head'
  const title = document.createElement('span')
  title.className = 'board-lane-title'
  title.textContent = lane.title
  head.append(title)
  if (lane.status !== '') head.append(tag('board-lane-status', lane.status))
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'board-lane-add'
  add.textContent = '+'
  const level = lane.kind === 'campaign-bugs' ? 'bug' : 'task'
  add.title = level === 'bug' ? 'New bug' : 'New task'
  add.setAttribute('aria-label', `${add.title} in ${lane.title}`)
  add.addEventListener('click', () => {
    openModal(level, lane.folderPath)
  })
  head.append(add)
  row.append(head)
  const columns = document.createElement('div')
  columns.className = 'board-columns'
  for (const status of BOARD_STATUSES) columns.append(columnFor(status, lane.columns[status]))
  row.append(columns)
  // Only a mission's lane answers to its own path. A bug lane's path is its
  // campaign's, so matching one here would give a campaign's click the Bugs
  // lane instead of the heading it asked for.
  if (lane.kind === 'mission' && lane.folderPath === revealed) row.classList.add('board-lane-revealed')
  return row
}

/**
 * What the note says, which is one thing at a time.
 *
 * A refusal wins over the findings count because it is the answer to
 * something the user just did; the count is standing context, and it comes
 * back the moment the refusal is cleared. The findings themselves are not
 * listed here: a file the board could not read is an entity that is not on
 * the board, so there is no card to hang it on — the tree has the row.
 *
 * An empty refusal is not a refusal: main sends one when the user answered a
 * confirmation with Cancel, the way `git:discard` already does, and the git
 * panel's own `say` treats it the same way — there is nothing to tell the
 * user that they do not already know, so the board falls back to the count
 * rather than blanking the line.
 */
function drawNote(): void {
  const note = el('board-note')
  if (refusal !== undefined && refusal !== '') {
    note.textContent = refusal
    note.hidden = false
    return
  }
  const count = latest?.findings.length ?? 0
  if (count === 0) {
    note.hidden = true
    return
  }
  note.textContent = `${String(count)} files could not be read. Open the tree to see which.`
  note.hidden = false
}

/**
 * Which of the panel's surfaces is on screen.
 *
 * One decision, made in one place, so the panel cannot show two at once —
 * they share `#board-groups`, and a second container would let a detail and
 * the columns both be in the document with only CSS keeping them apart. A
 * further destination is a further case here and a further `draw*` beside
 * the two below, not a rewrite of either.
 * @returns the surface `draw` should put in the container.
 */
function surface(): 'columns' | 'detail' {
  return detail === undefined ? 'columns' : 'detail'
}

/**
 * What every control in a detail does.
 *
 * Built once rather than per draw: none of them closes over the entity being
 * drawn — `renderDetail` passes the folder path of whatever row was pressed,
 * which is not always the entity the detail is about.
 */
const detailActions: DetailActions = {
  back: () => {
    detail = undefined
    draw()
  },
  open: (folderPath: string) => {
    void openDetail(folderPath)
  },
  openFile: (folderPath: string, file: string) => {
    window.pane.openTaskFile(folderPath, file)
  },
  setStatus: (folderPath: string, status: string) => {
    void move(folderPath, status)
  },
  tick: (folderPath: string, index: number, done: boolean) => {
    void flip(folderPath, index, done)
  },
}

/**
 * Draw the open entity in place of the columns.
 * @param into - the panel's one container.
 * @param empty - the line that words an absent board, which this surface has none of.
 */
function drawDetail(into: HTMLElement, empty: HTMLElement): void {
  if (detail === undefined) return
  empty.hidden = true
  into.append(renderDetail(detail, detailActions))
}

/**
 * Draw the board itself: a group per campaign, a lane per mission.
 * @param into - the panel's one container.
 * @param empty - the line that words a board with nothing on it.
 */
function drawColumns(into: HTMLElement, empty: HTMLElement): void {
  const groups = groupBoard(latest?.campaigns ?? [])
  if (groups.length === 0) {
    empty.textContent = 'The board is empty.'
    empty.hidden = false
    return
  }
  empty.hidden = true
  for (const group of groups) {
    const section = document.createElement('section')
    section.className = 'board-group'
    const heading = document.createElement('h2')
    heading.className = 'board-group-title'
    heading.textContent = group.campaign.name
    // A campaign is a heading on this board and nothing else, so its heading
    // is what a campaign row reveals. Matched here, above the lanes, so the
    // Bugs lane that shares its folder path never answers in its place.
    if (group.campaign.folderPath === revealed) heading.classList.add('board-group-revealed')
    section.append(heading)
    for (const lane of group.lanes) section.append(laneFor(lane))
    into.append(section)
  }
}

/**
 * Show one entity's detail, read fresh.
 *
 * Every way into the surface comes through here — a card, a child row, a link
 * row, the parent line — so there is one place that decides what happens when
 * the path names nothing: the columns come back with a line saying so, rather
 * than a blank detail of an entity that is not there. That is the same answer
 * `refresh` gives for an entity deleted while its detail was open, and it is
 * the reason a folder path is never trusted to still be on the board.
 * @param folderPath - the entity to open.
 * @returns resolution once the panel has been redrawn.
 */
async function openDetail(folderPath: string): Promise<void> {
  const next = await window.pane.readTaskDetail(folderPath)
  detail = next
  if (next === undefined) refusal = `${folderPath} is no longer on the board.`
  draw()
}

/**
 * Tick or untick one acceptance criterion, and say so when the store would not.
 *
 * `move`'s shape, for `move`'s reason: the box is not flipped before the
 * answer comes back, so a refusal needs no undo — the redraw that follows
 * puts the checkbox back where the file says it is.
 * @param folderPath - the entity the criterion belongs to.
 * @param index - the criterion's position in the list.
 * @param done - what the box was just set to.
 * @returns resolution once the answer has been drawn.
 */
async function flip(folderPath: string, index: number, done: boolean): Promise<void> {
  const out = await window.pane.tickCriterion(folderPath, index, done)
  refusal = out.ok ? undefined : out.reason
  draw()
}

/**
 * Redraw the panel from the last read.
 *
 * Rebuilt whole rather than patched, for the tree's reason: main re-reads the
 * whole board on every write an agent makes, a card carries no state of its
 * own beyond the drag that is already over, and a rebuild cannot disagree
 * with the data it is drawn from.
 *
 * The empty states above the switch are about the read and not about which
 * surface is showing: no project, no board, and a read that failed are all
 * answers to "is there anything here at all", and none of the surfaces has
 * anything to draw once one of them is true.
 */
function draw(): void {
  const into = el('board-groups')
  const empty = el('board-empty')
  into.textContent = ''
  if (trouble !== undefined) {
    empty.textContent = trouble
    empty.hidden = false
    el('board-note').hidden = true
    return
  }
  if (latest === undefined) {
    empty.hidden = true
    el('board-note').hidden = true
    return
  }
  drawNote()
  if (!latest.present) {
    // Two different absences, worded apart: a project with no board is worth
    // offering to start, and advice to create a campaign with no project open
    // names a place that does not exist.
    empty.textContent = latest.project === undefined
      ? 'No project is open, so there is no board.'
      : 'This project has no board yet. Ask the agent to plan something, or create a campaign.'
    empty.hidden = false
    return
  }
  switch (surface()) {
    case 'detail':
      drawDetail(into, empty)
      return
    case 'columns':
      drawColumns(into, empty)
      return
  }
}

/**
 * Open the create modal for one lane.
 *
 * The second field is the one thing worth asking for at the moment of
 * creating: the criterion that says when a task is done, or what happened for
 * a bug. Everything else about an entity is editing, which the file is for.
 * @param level - what is being created.
 * @param parent - the folder path it goes into.
 */
function openModal(level: 'task' | 'bug', parent: string): void {
  pending = { level, parent }
  el('board-modal-title').textContent = level === 'bug' ? 'New bug' : 'New task'
  el('board-modal-second-label').textContent = level === 'bug' ? 'What happened' : 'First acceptance criterion'
  const name = el('board-modal-name') as HTMLInputElement
  const second = el('board-modal-second') as HTMLInputElement
  name.value = ''
  second.value = ''
  const error = el('board-modal-error')
  error.textContent = ''
  error.hidden = true
  el('board-modal').hidden = false
  name.focus()
}

/**
 * Shut the modal and forget what it held.
 *
 * Reached from Cancel and from the close control, and from nothing else: not
 * a click on the backdrop, not Escape. Losing a half-typed task to a stray
 * gesture is small, infuriating, and exactly what stops someone trusting a
 * board with the next one.
 */
function closeModal(): void {
  pending = undefined
  ;(el('board-modal-name') as HTMLInputElement).value = ''
  ;(el('board-modal-second') as HTMLInputElement).value = ''
  const error = el('board-modal-error')
  error.textContent = ''
  error.hidden = true
  el('board-modal').hidden = true
}

/**
 * Ask the store for the thing the modal describes.
 *
 * A refusal keeps the modal open with everything still in it: the name is
 * work the user did, and throwing it away along with the reason it failed
 * leaves them with nothing to correct.
 * @returns resolution once the answer has been shown.
 */
async function create(): Promise<void> {
  if (pending === undefined) return
  const name = (el('board-modal-name') as HTMLInputElement).value.trim()
  const second = (el('board-modal-second') as HTMLInputElement).value.trim()
  const out = await window.pane.createBoardEntity(pending.level, pending.parent, name, second)
  if (out.ok) {
    closeModal()
    return
  }
  const error = el('board-modal-error')
  error.textContent = out.reason
  error.hidden = false
}

el('board-modal-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void create()
})
el('board-modal-cancel').addEventListener('click', closeModal)
el('board-modal-close').addEventListener('click', closeModal)
// Every press inside the modal, backdrop included, stops here: the backdrop
// takes pointer events precisely so it is the hit-test target for a click on
// the board behind it, and this is what keeps that click from bubbling on to
// a lane's plus or a card. There is deliberately no handler that closes on
// one: see `closeModal`.
el('board-modal').addEventListener('click', (event) => {
  event.stopPropagation()
})

/**
 * Re-read the board and redraw.
 *
 * The only caller of the bridge's reads, so every trigger costs one board and
 * — while a detail is open — one entity: main reads the whole board off disk
 * each time and never caches it, and a burst of agent writes arrives here as
 * one debounced notice.
 * @returns resolution once the board has been redrawn.
 */
async function refresh(): Promise<void> {
  try {
    const next = await window.pane.readTasks()
    // A refusal and a highlight are both about one board's paths, and a path
    // means nothing in the next project: `campaigns/q3` exists in both, and a
    // note about the one that was closed would sit over the one that opened.
    if (latest !== undefined && next.project !== latest.project) {
      refusal = undefined
      revealed = undefined
      detail = undefined
    }
    latest = next
    trouble = undefined
    // The open detail, re-read beside the board rather than kept from the
    // read that opened it: an agent's edit lands on both surfaces at once,
    // and an entity deleted while its detail was open falls back to the
    // columns with a line, which is the one thing a stale copy could not do.
    if (detail !== undefined) {
      const again = await window.pane.readTaskDetail(detail.folderPath)
      if (again === undefined) refusal = `${detail.folderPath} is no longer on the board.`
      detail = again
    }
  } catch (error) {
    // Nothing on the other side of the bridge rejects today. Without this it
    // would not have to: one that did would leave `latest` unset, which draws
    // as a blank panel with no message and no way to ask again.
    trouble = `The board could not be read: ${(error as Error).message}`
  }
  draw()
}

// Sent by main when the tree names a folder. The tab comes forward with it: a
// lane scrolled to inside a panel nobody can see looks like nothing happened.
window.pane.onReveal((folderPath) => {
  revealed = folderPath
  // A reveal always lands on the board: it names a card, a lane or a heading,
  // and all three are on the columns. Marking one behind an open detail would
  // scroll a surface nobody can see, which is the thing the tab-forward below
  // exists to prevent one level up.
  detail = undefined
  draw()
  document.getElementById('tab-board')?.click()
  // Whichever of the three the draw above marked, in document order — the
  // three selectors are mutually exclusive, since one folder path names one
  // campaign, one mission or one card.
  const target = document.querySelector<HTMLElement>(
    '.board-group-revealed, .board-lane-revealed, .board-card-revealed',
  )
  // Guarded because not every environment this page runs in implements it,
  // and a highlight that landed is worth more than the scroll that did not.
  if (typeof target?.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
})

// Main says when: the project moved, or something under `.dsh/tasks/` did.
// There is no polling, and this view never asks off its own timer.
window.pane.onTasksChanged(() => {
  void refresh()
})

void refresh()
