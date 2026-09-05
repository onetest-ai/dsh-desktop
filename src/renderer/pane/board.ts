import { BOARD_STATUSES, chipOf, groupBoard, type EntityView, type LaneView } from './board-rows.ts'
import './bridge.ts'
import type { BoardViewData } from './bridge.ts'
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

/** The lane main last asked to be shown, so a redraw keeps it marked. */
let revealed: string | undefined

/** What the modal is about to create, or undefined when it is closed. */
let pending: { level: 'task' | 'bug'; parent: string } | undefined

/**
 * The file an entity's own fields live in.
 *
 * The level decides it and nothing else does: a card holds a folder path, and
 * the folder holds exactly one of these.
 * @param entity - the card.
 * @returns the file name inside the entity's folder.
 */
function fileOf(entity: EntityView): string {
  return entity.level === 'bug' ? 'bug.yaml' : 'workitem.yaml'
}

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
 * @returns resolution once the answer has been drawn.
 */
async function trash(folderPath: string): Promise<void> {
  const out = await window.pane.trashBoardEntity(folderPath)
  refusal = out.ok ? undefined : out.reason
  draw()
}

/**
 * One card: a button that opens its file and can be dragged to a column.
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
  const chip = chipOf(entity)
  if (chip !== undefined) {
    const node = tag('board-chip', chip.text)
    if (chip.failing) node.classList.add('board-chip-failing')
    card.append(node)
  }
  card.addEventListener('click', () => {
    window.pane.openTaskFile(entity.folderPath, fileOf(entity))
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
  // and every press on it would also open the file.
  remove.hidden = true
  remove.addEventListener('click', () => {
    void trash(entity.folderPath)
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
  const holds = BOARD_STATUSES.some((status) => lane.columns[status].some((card) => card.folderPath === revealed))
  if (revealed === lane.folderPath || holds) row.classList.add('board-lane-revealed')
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
 */
function drawNote(): void {
  const note = el('board-note')
  if (refusal !== undefined) {
    note.textContent = refusal
    note.hidden = false
    return
  }
  const count = latest?.findings.length ?? 0
  note.textContent = `${String(count)} files could not be read. Open the tree to see which.`
  note.hidden = count === 0
}

/**
 * Redraw the board from the last read.
 *
 * Rebuilt whole rather than patched, for the tree's reason: main re-reads the
 * whole board on every write an agent makes, a card carries no state of its
 * own beyond the drag that is already over, and a rebuild cannot disagree
 * with the data it is drawn from.
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
    // The one empty state with a way out of it, so it says what to do rather
    // than only what is missing.
    empty.textContent = 'This project has no board yet. Ask the agent to plan something, or create a campaign.'
    empty.hidden = false
    return
  }
  const groups = groupBoard(latest.campaigns)
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
    section.append(heading)
    for (const lane of group.lanes) section.append(laneFor(lane))
    into.append(section)
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
// The modal's own presses stop here so nothing behind it can act on them.
// There is deliberately no handler on anything outside it: see `closeModal`.
el('board-modal').addEventListener('click', (event) => {
  event.stopPropagation()
})

/**
 * Re-read the board and redraw.
 *
 * The only caller of the bridge's read, so every trigger costs one: main
 * reads the whole board off disk each time and never caches it, and a burst
 * of agent writes arrives here as one debounced notice.
 * @returns resolution once the board has been redrawn.
 */
async function refresh(): Promise<void> {
  try {
    latest = await window.pane.readTasks()
    trouble = undefined
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
  draw()
  document.getElementById('tab-board')?.click()
  const lane = document.querySelector<HTMLElement>('.board-lane-revealed')
  // Guarded because not every environment this page runs in implements it,
  // and a highlight that landed is worth more than the scroll that did not.
  if (typeof lane?.scrollIntoView === 'function') lane.scrollIntoView({ block: 'nearest' })
})

// Main says when: the project moved, or something under `.dsh/tasks/` did.
// There is no polling, and this view never asks off its own timer.
window.pane.onTasksChanged(() => {
  void refresh()
})

void refresh()
