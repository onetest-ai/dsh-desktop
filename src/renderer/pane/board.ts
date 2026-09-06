import { backButton, type DetailActions, renderDetail, type Surface, tag } from './board-detail.ts'
import { BOARD_STATUSES, groupBoard, statusLabel, type EntityView, type LaneView } from './board-rows.ts'
import './bridge.ts'
import type { BoardViewData, EntityDetailView, SuiteView, TestView } from './bridge.ts'
import { statusGlyph, verdictDot } from './status-glyph.ts'
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
 * The folder paths of the campaigns and missions the reader has folded shut.
 *
 * A posture and not a decision, so it lives here rather than in a file: a board
 * folded away last Tuesday that reopened folded would have decided something
 * for the reader, the way a remembered detail would. It is a `Set` of paths and
 * not a flag per row for the tree's own reason — the fold state cannot outlive
 * a redraw if it is written into the DOM, and every write an agent makes throws
 * the DOM away and draws it again from this. One `Set` for both kinds because a
 * campaign path and a mission path never collide: a mission's path is its
 * campaign's with `/missions/…` on the end, so `has` answers for exactly the
 * row that owns the path and never the one above or below it. Cleared on a
 * project change beside `refusal` and `revealed`, because `campaigns/q3` names
 * different work in the next repository and a fold carried across is a board
 * this state was never about.
 */
const folded = new Set<string>()

/**
 * Fold or unfold one row, then redraw from the new posture.
 *
 * The toggle a campaign heading and a mission's header both call. It draws
 * rather than patches for the reason the whole panel does: the fold is one bit
 * of the board's shape, and a board rebuilt whole from `folded` cannot show a
 * chevron pointing one way over columns that went the other.
 * @param path - the folder path of the row that was activated.
 */
function toggleFold(path: string): void {
  if (folded.has(path)) folded.delete(path)
  else folded.add(path)
  draw()
}

/**
 * A disclosure chevron that points down when open and right when shut.
 *
 * An inline SVG rather than a glyph font or a character, so it is one shape the
 * stylesheet rotates rather than two the markup swaps — and drawn in
 * `currentColor` so the one token its class sets is the only colour it can be,
 * the same discipline every mark on this board keeps. `aria-hidden` because the
 * button around it is already named by the row's own words; the chevron is the
 * affordance, not a second label of it.
 * @param collapsed - whether the row it marks is folded, which rotates it.
 * @returns the chevron, ready to prepend to a fold control.
 */
function chevron(collapsed: boolean): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('board-fold-chevron')
  if (collapsed) svg.classList.add('board-fold-chevron-collapsed')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M3 4.5 L6 7.5 L9 4.5')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}

/**
 * Where the panel is: which of its three surfaces is on screen, and — for the
 * detail — which one it was opened over.
 *
 * One value rather than a nullable detail beside a Tests flag. Two variables
 * could say things the panel has no way to be: a detail open *and* the Tests
 * list standing behind it was the shape that let a reveal clear the detail,
 * leave the flag, and land the reader back on the list it was taking them
 * off. A surface that is not on screen cannot be forgotten about here,
 * because there is nowhere to forget it.
 *
 * The detail carries the whole entity rather than the folder path it was
 * opened from: it is what `draw` renders, and holding only the path would
 * mean either a read inside `draw` — which is synchronous and called from
 * every redraw — or a second copy of the entity kept somewhere else. Re-read
 * in `refresh` alongside the board, from the same walk of the same files, so
 * the detail and the card it was opened from cannot disagree.
 *
 * It carries `under` because back walks out one level and the two destinations
 * stack: a test opened from the Tests list returns to the list, a card's
 * detail returns to the columns. That history is one field of the state it is
 * about, rather than something inferred from what else happens to be set.
 *
 * A project change walks out of a detail and keeps the Tests list, which is
 * one rule and not two: an open detail and `revealed` both name a path, and a
 * path means something else in the next repository, while Tests names a
 * destination every board has. Nothing here is remembered across a session
 * either — a panel that reopened on the task you were reading last Tuesday
 * has decided something for you.
 */
type Place =
  | { at: 'columns' }
  | { at: 'tests' }
  | { at: 'detail'; entity: EntityDetailView; under: Surface }

let place: Place = { at: 'columns' }

/**
 * How many times the panel has been sent somewhere.
 *
 * A counter rather than a comparison of `place` values, because two of the
 * reads that end in a place are one await long and the reader can act inside
 * that await. `refresh` re-reads the open detail; `openDetail` reads the
 * entity a row named. Both used to assign `place` unconditionally when the
 * answer landed, so a back press — or a reveal — that happened in between was
 * silently undone, and a detail the reader had just closed came back on its
 * own.
 *
 * Every gesture that decides where the panel goes bumps this first, and every
 * read that is about to decide checks that nothing has bumped it since. The
 * newest gesture wins, which is the reader's most recent instruction; a read
 * that lost simply draws nothing, because whoever won has already drawn.
 */
let moves = 0

/**
 * Put the panel on a surface, as a gesture rather than as an assignment.
 * @param next - where the panel now is.
 */
function goTo(next: Place): void {
  place = next
  moves += 1
}

/** What the modal is about to create, or undefined when it is closed. */
let pending: { level: 'task' | 'bug'; parent: string } | undefined

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
  // The slug — the folder's own last segment — above the name: it is the
  // thing an agent's commit message or a terminal path names, and the name is
  // the reader's own words for the same entity. Ordering them slug-first reads
  // like a file header, machine line above human one.
  const segments = entity.folderPath.split('/').filter((segment) => segment !== '')
  const slug = document.createElement('span')
  slug.className = 'board-card-slug'
  slug.textContent = segments.length > 0 ? segments[segments.length - 1] : entity.folderPath
  card.append(slug)
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
  // The dot carries the verdict now — pass, fail, or none — so the word
  // "passing" and the failing-red text it used to colour are both gone from
  // here; a card with nothing to validate it draws no dot and no count, the
  // same absence a verdict-less card has always shown.
  const { pass, total } = entity.verdicts
  if (total > 0) {
    const verdicts = document.createElement('span')
    verdicts.className = 'board-card-verdicts'
    verdicts.append(verdictDot(pass, total))
    verdicts.append(tag('board-card-verdict-count', `${String(pass)}/${String(total)}`))
    card.append(verdicts)
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
  // The glyph first, so a column reads by its shape before anyone reads the
  // word beside it — the same mark this status draws on every card sitting
  // under it and on the lane tag alongside it, so one status is one shape
  // wherever the board draws it.
  title.append(statusGlyph(status))
  // The label, not the stored value: `validation` is the file's word and
  // Validation is the reader's. The class on the column itself keeps the raw
  // one, which is what the stylesheet and the drop both address it by.
  const label = document.createElement('span')
  label.className = 'board-column-label'
  label.textContent = statusLabel(status)
  title.append(label)
  // How many cards sit under the label, so a column empty enough to matter
  // does not need counting by eye.
  const count = document.createElement('span')
  count.className = 'board-column-count'
  count.textContent = String(cards.length)
  title.append(count)
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
  // A mission's header is its own toggle, so folding it is one press on the
  // thing it folds. A bug lane is not a mission and does not fold — it is a
  // campaign's overflow, never a unit of work someone puts down — so its title
  // stays a plain span, and only the mission's becomes a button reachable by
  // tab and pressed by Enter. The chevron leads the title either way it points.
  const collapsed = lane.kind === 'mission' && folded.has(lane.folderPath)
  let title: HTMLElement
  if (lane.kind === 'mission') {
    const button = document.createElement('button')
    button.type = 'button'
    button.append(chevron(collapsed))
    const label = document.createElement('span')
    label.className = 'board-lane-name'
    label.textContent = lane.title
    button.append(label)
    button.addEventListener('click', () => {
      toggleFold(lane.folderPath)
    })
    title = button
  } else {
    title = document.createElement('span')
    title.textContent = lane.title
  }
  title.className = 'board-lane-title'
  head.append(title)
  // The label, as the column heading beside it reads: the same status on the
  // same screen, drawn twice, should not read as `executing` in one place and
  // Executing in the other. The glyph beside it is the same one that heading
  // draws too, so the lane's own status and the column it points into read as
  // one shape rather than two spellings of it.
  if (lane.status !== '') {
    const statusTag = tag('board-lane-status', statusLabel(lane.status))
    statusTag.prepend(statusGlyph(lane.status))
    head.append(statusTag)
  }
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
  // A folded lane keeps its head — the chevron, the title, the status, the plus
  // — and drops only its columns: folding is putting the work down where it is,
  // not losing sight of the lane it was in, and the plus stays so a new card can
  // still be filed into a lane the reader is not looking through right now.
  if (!collapsed) {
    const columns = document.createElement('div')
    columns.className = 'board-columns'
    for (const status of BOARD_STATUSES) columns.append(columnFor(status, lane.columns[status]))
    row.append(columns)
  }
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
 * What every control in a detail does.
 *
 * Built once rather than per draw: none of them closes over the entity being
 * drawn — `renderDetail` passes the folder path of whatever row was pressed,
 * which is not always the entity the detail is about.
 */
const detailActions: DetailActions = {
  back: () => {
    // One level, not all the way out: a test opened from the Tests list
    // lands back on the list it was picked from, and a card's detail lands
    // on the columns because that is where its card was. Which of the two it
    // is was settled when the detail opened; nothing here has to work it out.
    if (place.at === 'detail') goTo({ at: place.under })
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
  openLink: (url: string) => {
    // Where the user's links open, which is the same answer the editor's
    // preview gives: this page is not a browser, and it is the page that
    // holds the preload.
    window.pane.openExternal(url)
  },
  edit: (folderPath, patch) => {
    void edit(folderPath, patch)
  },
  addCriterion: (folderPath, text) => {
    void addCriterion(folderPath, text)
  },
  linkTest: (folderPath, test, comment) => {
    void linkTest(folderPath, test, comment)
  },
  attachDoc: (folderPath, label, target) => {
    void attachDoc(folderPath, label, target)
  },
}

/**
 * Draw the open entity in place of the columns.
 * @param into - the panel's one container.
 * @param empty - the line that words an absent board, which this surface has none of.
 * @param entity - the entity `place` says is open, passed rather than read back out of it.
 * @param under - the surface it was opened over, which is what back says and does.
 */
function drawDetail(into: HTMLElement, empty: HTMLElement, entity: EntityDetailView, under: Surface): void {
  empty.hidden = true
  into.append(renderDetail(entity, detailActions, under))
}

/**
 * Whether a suite holds a test anywhere beneath it.
 *
 * The same predicate the tree applies to the same tree, for the same reason:
 * a heading with nothing under it is a section the reader has to look into to
 * find out it is empty. Written here rather than shared because the two pages
 * share only pure modules, and a one-line predicate is a poor reason to make
 * `board-rows.ts` know what a suite is.
 * @param suite - the suite to look through.
 * @returns whether there is a test anywhere beneath it.
 */
function suiteHolds(suite: SuiteView): boolean {
  return suite.tests.length > 0 || suite.suites.some(suiteHolds)
}

/**
 * One test, as a row of the Tests list.
 *
 * The count is the reverse of a card's dot — what this test proves, rather
 * than what proves that card — but the drawing is the same one `cardFor`
 * settled on: a coloured dot for the verdict, a neutral count beside it, and
 * neither one at all when there is nothing here to validate.
 * @param test - the test to draw.
 * @returns the row, ready to append.
 */
function testRow(test: TestView): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'board-tests-row'
  const name = document.createElement('span')
  name.className = 'board-detail-row-name'
  name.textContent = test.name
  row.append(name)
  const { pass, total } = test.validates
  if (total > 0) {
    row.append(verdictDot(pass, total))
    row.append(tag('board-card-verdict-count', `${String(pass)}/${String(total)}`))
  }
  row.addEventListener('click', () => {
    // The detail, which is the surface everything else on this board opens
    // into: a list that could only be looked at would be a dead end, and the
    // test's own steps and verdicts are what somebody came here for.
    void openDetail(test.folderPath)
  })
  return row
}

/**
 * One suite and everything beneath it, headings first.
 *
 * Depth is drawn as indentation rather than as a fold: the list is read at a
 * glance and a suite tree is shallow, so a twisty here would be a control
 * whose only use is putting back what it just took away.
 * @param suite - the suite to draw.
 * @param depth - how far in it sits, the root being zero.
 * @returns the suite's block, ready to append.
 */
function suiteBlock(suite: SuiteView, depth: number): HTMLElement {
  const box = document.createElement('div')
  box.className = 'board-tests-suite-box'
  if (depth > 0) {
    const heading = document.createElement('h3')
    heading.className = 'board-tests-suite'
    heading.textContent = suite.slug
    box.append(heading)
  }
  for (const test of suite.tests) box.append(testRow(test))
  // Sub-suites after the tests directly in this one, so a suite's own cases
  // are not pushed below the whole depth of everything nested under it.
  for (const child of suite.suites) {
    if (suiteHolds(child)) box.append(suiteBlock(child, depth + 1))
  }
  return box
}

/**
 * Draw the suite tree in place of the columns.
 *
 * A test has no status and so no column, which is exactly why this exists: it
 * is the only way to a test that does not require already knowing the test is
 * there. Its own back is the detail's own control rather than a copy of it,
 * because the two are the same gesture on the same panel — and two hard-coded
 * labels a foot apart is how one of them came to name a surface it did not go
 * to.
 * @param into - the panel's one container.
 * @param empty - the line that words an absent board, which this surface has none of.
 */
function drawTests(into: HTMLElement, empty: HTMLElement): void {
  empty.hidden = true
  const box = document.createElement('section')
  box.className = 'board-tests'
  const head = document.createElement('div')
  head.className = 'board-detail-head'
  const back = backButton('columns', () => {
    goTo({ at: 'columns' })
    draw()
  })
  const title = document.createElement('h2')
  title.className = 'board-detail-title'
  title.textContent = 'Tests'
  head.append(back, title)
  box.append(head)
  const root = latest?.tests
  if (root === undefined || !suiteHolds(root)) {
    const line = document.createElement('p')
    line.className = 'board-detail-blank'
    line.textContent = 'No tests yet.'
    box.append(line)
  } else {
    box.append(suiteBlock(root, 0))
  }
  into.append(box)
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
    const collapsed = folded.has(group.campaign.folderPath)
    const heading = document.createElement('h2')
    heading.className = 'board-group-title'
    // The heading is the fold control, drawn as a button inside the h2 rather
    // than as the h2 itself: a campaign is a heading on this board, and a
    // heading that is also a landmark keeps that role while the button inside it
    // is what a tab reaches and Enter presses. The chevron leads the name and
    // rotates with the state; a folded campaign shows exactly this and no lanes.
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'board-group-fold'
    toggle.append(chevron(collapsed))
    const name = document.createElement('span')
    name.className = 'board-group-name'
    name.textContent = group.campaign.name
    toggle.append(name)
    toggle.addEventListener('click', () => {
      toggleFold(group.campaign.folderPath)
    })
    heading.append(toggle)
    // A campaign is a heading on this board and nothing else, so its heading
    // is what a campaign row reveals. Matched here, above the lanes, so the
    // Bugs lane that shares its folder path never answers in its place.
    if (group.campaign.folderPath === revealed) heading.classList.add('board-group-revealed')
    section.append(heading)
    if (!collapsed) for (const lane of group.lanes) section.append(laneFor(lane))
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
  // What back will return to: whatever is on screen when the row was pressed,
  // and for a detail opened from inside another detail, the surface that one
  // was opened over — a chain of child rows is still one level in from where
  // it started. Read before the await, not after: by the time the answer lands
  // the panel may be somewhere else entirely.
  const under = place.at === 'detail' ? place.under : place.at
  // The press is itself a move, decided now even though where it lands is not
  // known until the read comes back.
  moves += 1
  const mine = moves
  const next = await window.pane.readTaskDetail(folderPath)
  // Something newer has sent the panel somewhere since — a reveal, a back, a
  // second row. That instruction is the reader's latest one and it has already
  // been drawn; this one is stale.
  if (mine !== moves) return
  goTo(next === undefined ? { at: under } : { at: 'detail', entity: next, under })
  if (next === undefined) refusal = `${folderPath} is no longer on the board.`
  draw()
}

/**
 * Tick or untick one acceptance criterion, and say so when the store would not.
 *
 * `move`'s shape, for `move`'s reason: the box is not flipped before the
 * answer comes back, so a refusal needs no undo — the redraw that follows
 * puts the checkbox back where the file says it is.
 *
 * Clearing the standing refusal on success is `move`'s line too, and the
 * rule it belongs to is "a write this view made that worked", not "a drag or
 * a delete": a line explaining why a card would not move, still up over a
 * detail whose criterion just ticked, is about a gesture the surface no
 * longer shows. The spec's sentence names the writes that existed when it
 * was written and has been widened to say the rule instead.
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
 * Save an edited prose field, and say so only when the store would not.
 *
 * Unlike `move` and `flip`, this never redraws on its own — not even on
 * success. The detail's edit fields hold what the user just typed, and `draw`
 * rebuilds the whole surface from the entity as it was last read, which is
 * stale until the write's own `tasks:changed` brings a fresh one. So on success
 * the note is cleared and the redraw is left to that notice; on a refusal only
 * the note is drawn, over a detail left standing — which is what keeps the
 * typed edit from being thrown away along with the reason it was refused.
 * @param folderPath - the entity being edited.
 * @param patch - the description or the one section the field changed.
 * @returns resolution once the answer has been shown.
 */
async function edit(folderPath: string, patch: { description?: string; section?: { heading: string; body: string } }): Promise<void> {
  const out = await window.pane.updateBoardEntity(folderPath, patch)
  refusal = out.ok ? undefined : out.reason
  drawNote()
}

/**
 * Append an acceptance criterion, and say so only when the store would not.
 *
 * `edit`'s shape and `edit`'s reason: the add field holds what the user typed,
 * so a refusal draws the note without rebuilding the surface, and a success
 * leaves the redraw — the new criterion, the emptied field — to the
 * `tasks:changed` the write brings.
 * @param folderPath - the entity to add it to.
 * @param text - what has to be true.
 * @returns resolution once the answer has been shown.
 */
async function addCriterion(folderPath: string, text: string): Promise<void> {
  const out = await window.pane.addBoardCriterion(folderPath, text)
  refusal = out.ok ? undefined : out.reason
  drawNote()
}

/**
 * Declare that a test proves this workitem, and say so only when the store would not.
 *
 * `edit`'s shape and `edit`'s reason. The verdict is main's to fix — a freshly
 * declared link is unrun — so only the path and the comment cross here.
 * @param folderPath - the workitem being proved.
 * @param test - the test's folder path.
 * @param comment - why, in the reader's own words; may be empty.
 * @returns resolution once the answer has been shown.
 */
async function linkTest(folderPath: string, test: string, comment: string): Promise<void> {
  const out = await window.pane.linkBoardTest(folderPath, test, comment)
  refusal = out.ok ? undefined : out.reason
  drawNote()
}

/**
 * Attach one document link to the open entity, and say so only when the store would not.
 *
 * `edit`'s shape and `edit`'s reason for what it draws — a refusal shows the
 * note over a detail left standing, a success leaves the redraw to the write's
 * own `tasks:changed`. What is its own is where the new list comes from: the
 * bridge's documents seam takes the whole array, not a delta, so the current
 * links are read off the open detail and the typed pair is appended to them. A
 * blank label is named after its target, since the store keeps whatever label
 * it is given and an empty one on the card would read as a link the file failed
 * to name. The list is read only when a detail is what is open — the control
 * that calls this is drawn nowhere else — so any other place is a no-op rather
 * than a write against a list this surface does not hold.
 * @param folderPath - the campaign or mission being attached to.
 * @param label - what to call the link; empty falls back to the target.
 * @param target - where it points, already known non-empty by the control.
 * @returns resolution once the answer has been shown.
 */
async function attachDoc(folderPath: string, label: string, target: string): Promise<void> {
  if (place.at !== 'detail') return
  const current = place.entity.documents
  const documents = [...current, { label: label === '' ? target : label, target }]
  const out = await window.pane.updateBoardEntity(folderPath, { documents })
  refusal = out.ok ? undefined : out.reason
  drawNote()
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
 *
 * Which surface goes into the container is one decision made in one place, so
 * the panel cannot show two at once — they share `#board-groups`, and a second
 * container would let a detail and the columns both be in the document with
 * only CSS keeping them apart. A further destination is a further case here
 * and a further `draw*` beside the three below, not a rewrite of any.
 */
function draw(): void {
  const into = el('board-groups')
  const empty = el('board-empty')
  const head = el('board-head')
  into.textContent = ''
  // The columns' own chrome, and only theirs: a destination carries its own
  // back, and a Tests control left up behind one would be a second way out
  // beside it, going somewhere the reader did not come from.
  head.hidden = true
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
  // Read out once, so the switch below narrows the union it is switching on
  // and the detail's entity comes from the same value that chose the case.
  const here = place
  switch (here.at) {
    case 'detail':
      drawDetail(into, empty, here.entity, here.under)
      return
    case 'tests':
      drawTests(into, empty)
      return
    case 'columns':
      // Shown whether or not this board has a test in it. A control that came
      // and went with the suite tree would make the destination something you
      // have to already know about, which is the thing it exists to fix — the
      // list words its own emptiness instead.
      head.hidden = false
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

el('board-tests').addEventListener('click', () => {
  goTo({ at: 'tests' })
  draw()
})

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
      // The fold posture is keyed by folder path too, and a path is another
      // project's work in the next repository: a campaign left folded across
      // the change would be this state describing a board it was never about.
      folded.clear()
      // Out of the detail and no further: what it walks out to is the Tests
      // list when that is what it was opened over, which survives the change
      // because it names a destination rather than a path.
      if (place.at === 'detail') goTo({ at: place.under })
    }
    latest = next
    trouble = undefined
    // The open detail, re-read beside the board rather than kept from the
    // read that opened it: an agent's edit lands on both surfaces at once,
    // and an entity deleted while its detail was open falls back to the
    // surface it was opened over, with a line — the one thing a stale copy
    // could not do.
    const open = place
    if (open.at === 'detail') {
      // Not a move of its own: a re-read is the panel keeping up with the
      // files, never the panel deciding where the reader is. So it takes the
      // count as it stands and gives the surface up if anything moves it while
      // the entity is being read.
      const mine = moves
      const again = await window.pane.readTaskDetail(open.entity.folderPath)
      if (mine === moves) {
        if (again === undefined) refusal = `${open.entity.folderPath} is no longer on the board.`
        place = again === undefined ? { at: open.under } : { at: 'detail', entity: again, under: open.under }
      }
    }
  } catch (error) {
    // Nothing on the other side of the bridge rejects today. Without this it
    // would not have to: one that did would leave `latest` unset, which draws
    // as a blank panel with no message and no way to ask again.
    trouble = `The board could not be read: ${(error as Error).message}`
  }
  draw()
}

/**
 * Whether a folder path names a test on the board that was last read.
 *
 * Asked of the read rather than of the string: `tests/` is a convention and a
 * path that merely starts with it is not proof of anything, while the suite
 * tree is the board's own answer to which tests exist.
 * @param suite - the suite to look through, or undefined before the first read.
 * @param folderPath - the path the tree named.
 * @returns whether a test in that tree carries it.
 */
function isTest(suite: SuiteView | undefined, folderPath: string): boolean {
  if (suite === undefined) return false
  return (
    suite.tests.some((test) => test.folderPath === folderPath) ||
    suite.suites.some((child) => isTest(child, folderPath))
  )
}

// Sent by main when the tree names a folder. The tab comes forward with it: a
// lane scrolled to inside a panel nobody can see looks like nothing happened.
window.pane.onReveal((folderPath) => {
  // A test is the one thing the tree can name that this board draws no card
  // for, so a highlight would point at nothing. The panel is the side that
  // knows which paths are tests — the tree sends the same message for every
  // row — and the answer for one is the detail, the same surface a card's
  // click opens.
  if (isTest(latest?.tests, folderPath)) {
    // The mark goes with it. It says which row the tree has selected, and the
    // tree has just selected this test — a card still highlighted underneath
    // is the previous click outliving this one, which is what the reader
    // finds when they back out of the detail.
    revealed = undefined
    goTo({ at: 'columns' })
    void openDetail(folderPath)
    document.getElementById('tab-board')?.click()
    return
  }
  revealed = folderPath
  // A reveal unfolds whatever it has to: a card in a folded lane, or a lane
  // under a folded campaign, is a target the mark would land on with nothing
  // to see it against. Every folded ancestor of the named path is opened — a
  // path is an ancestor when the target is it or sits beneath it — and the
  // target itself if it is a folded row, so the campaign and the mission it
  // lives in are both open by the time the draw below marks it.
  for (const path of [...folded]) {
    if (folderPath === path || folderPath.startsWith(`${path}/`)) folded.delete(path)
  }
  // A reveal always lands on the columns: it names a card, a lane or a
  // heading, and all three are drawn there. Whatever stood over them — a
  // detail, or the Tests list — is precisely what the reader is being taken
  // off, and leaving one up would scroll and mark a surface it is not on,
  // which is what the tab-forward below exists to prevent one level up.
  goTo({ at: 'columns' })
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
