import { BOARD_STATUSES, statusLabel } from './board-rows.ts'
import type { EntityDetailView } from './bridge.ts'
import { openMarkdownLink, renderMarkdown } from './markdown.ts'

/**
 * What a detail can do, handed in rather than reached for.
 *
 * Every one of these is a call to main, and none of them is made here: this
 * module turns one entity into DOM and nothing else, which is what lets the
 * whole surface be drawn and read in jsdom without a bridge to stub. The
 * folder path travels with each call because a row can be about an entity
 * other than the one being drawn — a child, a link, the parent above it.
 */
export interface DetailActions {
  /** Leave the detail and put the columns back. */
  back: () => void
  /** Open another entity's detail: a child row, a link row, the parent line. */
  open: (folderPath: string) => void
  /** Hand a file to the editor column. */
  openFile: (folderPath: string, file: string) => void
  /** Write a status, from the select. */
  setStatus: (folderPath: string, status: string) => void
  /** Tick or untick one acceptance criterion, by its position in the list. */
  tick: (folderPath: string, index: number, done: boolean) => void
  /** Send a link in the prose where the user's links go, which is not here. */
  openLink: (url: string) => void
}

/**
 * A heading for one part of the detail.
 * @param text - what it says.
 * @returns the heading, ready to append.
 */
function heading(text: string): HTMLElement {
  const node = document.createElement('h3')
  node.className = 'board-detail-heading'
  node.textContent = text
  return node
}

/**
 * The line a section with nothing under it draws instead of nothing.
 *
 * A heading with an empty gap beneath it reads as a bug in the view; this
 * reads as an invitation. The heading itself is never dropped — a section the
 * detail hid would be a field the reader never learns the file has.
 * @returns the line, ready to append.
 */
function blankLine(): HTMLElement {
  const node = document.createElement('p')
  node.className = 'board-detail-blank'
  node.textContent = 'Nothing here yet.'
  return node
}

/**
 * One block of prose, as markdown.
 *
 * `innerHTML` with `renderMarkdown`'s output, which is the same pair the
 * editor's preview already is: that function sanitises without exception, and
 * this page holds the preload that reaches the filesystem — so the sanitiser
 * is what makes the insertion safe, and inserting the source instead would
 * hand a `.md` an agent wrote this page's own access.
 *
 * The sanitiser keeps an `<a href>`, so the click is the other half of the
 * same pair, and the preview's handler cannot do it for us — that one is
 * bound to `#preview` and this lives in `#board-groups`. Every anchor is
 * stopped, not only the ones that go somewhere: a detail is not a browser,
 * and a link followed in place would put a page the file named where this
 * page's preload is, on a surface whose only control is a back that no longer
 * exists. An http(s) link then goes where the user's links go and everything
 * else — a relative path into a project this surface does not resolve —
 * goes nowhere at all.
 * @param text - the markdown source.
 * @param on - what the surface can do, for the one link it may follow.
 * @returns the rendered block, ready to append.
 */
function prose(text: string, on: DetailActions): HTMLElement {
  const node = document.createElement('div')
  node.className = 'board-detail-prose'
  node.innerHTML = renderMarkdown(text)
  node.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest('a')
    if (anchor === null || anchor === undefined) return
    event.preventDefault()
    const url = openMarkdownLink(anchor)
    if (url !== undefined) on.openLink(url)
  })
  return node
}

/**
 * A small dimmed tag, as a card's own tags are drawn.
 *
 * Exported for `board.ts`, which draws the cards: the two surfaces are one
 * bundle and one stylesheet, and two copies of five lines is two places for
 * the class name to drift from what the CSS says.
 * @param className - what kind of tag it is, for the stylesheet.
 * @param text - what it says.
 * @returns the tag, ready to append.
 */
export function tag(className: string, text: string): HTMLElement {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

/**
 * One row that opens another entity's detail.
 *
 * A button rather than a link, for a card's reason: it is reachable by tab and
 * pressed by Enter, and there is no address for a link to name — the surface
 * navigates into itself.
 * @param name - what the row is called.
 * @param note - the status or verdict beside it, if any.
 * @param failing - whether that note reads as a failure.
 * @param go - what pressing it does.
 * @returns the row, ready to append.
 */
function rowFor(name: string, note: string, failing: boolean, go: () => void): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'board-detail-row'
  const label = document.createElement('span')
  label.className = 'board-detail-row-name'
  label.textContent = name
  row.append(label)
  if (note !== '') {
    const chip = tag(failing ? 'board-chip board-chip-failing' : 'board-detail-row-note', note)
    row.append(chip)
  }
  row.addEventListener('click', go)
  return row
}

/**
 * The header: back, the name, the status, and Open file.
 *
 * Back comes first and is the left-most thing on the surface, because it is
 * the answer to "where am I" — a detail that replaced the board without one
 * would be a dead end rather than a place.
 * @param detail - the entity being drawn.
 * @param on - what the surface can do.
 * @returns the header, ready to append.
 */
function headFor(detail: EntityDetailView, on: DetailActions): HTMLElement {
  const head = document.createElement('div')
  head.className = 'board-detail-head'
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'board-detail-back'
  back.textContent = '← Board'
  back.addEventListener('click', on.back)
  head.append(back)
  const title = document.createElement('h2')
  title.className = 'board-detail-title'
  title.textContent = detail.name
  head.append(title)
  // A test has no status at all, so it gets no pill: an empty one would read
  // as a status the file failed to say rather than as one it never has.
  if (detail.status !== '') head.append(tag('board-detail-status', statusLabel(detail.status)))
  const file = document.createElement('button')
  file.type = 'button'
  file.className = 'board-detail-file'
  file.textContent = 'Open file'
  file.addEventListener('click', () => {
    on.openFile(detail.folderPath, detail.file)
  })
  head.append(file)
  return head
}

/**
 * The status select, which is one of the two things editable here.
 *
 * A status the board has no column for is added to the list rather than
 * silently redrawn as `idea`: the select would otherwise claim the file says
 * something it does not, and one change of any other field would then write
 * that claim into it. It is a finding, and the tree is where it is named.
 * @param detail - the entity being drawn.
 * @param on - what the surface can do.
 * @returns the labelled select, ready to append.
 */
function statusFor(detail: EntityDetailView, on: DetailActions): HTMLElement {
  const field = document.createElement('label')
  field.className = 'board-detail-field'
  const label = document.createElement('span')
  label.textContent = 'Status'
  const select = document.createElement('select')
  select.className = 'board-detail-select'
  const statuses = BOARD_STATUSES.includes(detail.status) ? BOARD_STATUSES : [...BOARD_STATUSES, detail.status]
  for (const status of statuses) {
    const option = document.createElement('option')
    option.value = status
    option.textContent = statusLabel(status)
    select.append(option)
  }
  select.value = detail.status
  select.addEventListener('change', () => {
    on.setStatus(detail.folderPath, select.value)
  })
  field.append(label, select)
  return field
}

/**
 * The acceptance criteria, as checkboxes rather than as the list's markdown.
 *
 * The other of the two editable things, and the reason the detail is handed
 * `criteria` parsed as well as the section they came from: a `- [ ]` rendered
 * as markdown is a picture of a checkbox, and this is the checkbox.
 * @param detail - the entity being drawn.
 * @param on - what the surface can do.
 * @returns the list, or the blank line when there are none.
 */
function criteriaFor(detail: EntityDetailView, on: DetailActions): HTMLElement {
  if (detail.criteria.length === 0) return blankLine()
  const list = document.createElement('ul')
  list.className = 'board-detail-criteria'
  detail.criteria.forEach((criterion, index) => {
    const item = document.createElement('li')
    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'board-detail-tick'
    box.checked = criterion.done
    box.addEventListener('change', () => {
      on.tick(detail.folderPath, index, box.checked)
    })
    const text = document.createElement('span')
    text.textContent = criterion.text
    label.append(box, text)
    item.append(label)
    list.append(item)
  })
  return list
}

/**
 * Criteria the level's own document has no section for, reported as such.
 *
 * `LEVEL_SECTIONS` gives Acceptance Criteria to a campaign, a mission and a
 * task; a bug and a test never own one — the spec is explicit that a test is
 * a criterion made executable and carries none of its own. So criteria on
 * either are malformed data, and the board's rule for malformed data is that
 * it is reported rather than repaired or hidden. Drawing nothing would leave
 * the file saying something no reader of this surface could ever see, and
 * the file is the only place it could be fixed.
 *
 * Read-only, unlike the section a task draws: the store refuses a tick on a
 * level that owns no criteria, so a checkbox here would be a control that
 * always answers with a refusal.
 * @param detail - the entity being drawn.
 * @returns the block, or nothing when the level owns the section or the file
 *   has no criteria in it.
 */
function strayCriteriaFor(detail: EntityDetailView): HTMLElement | undefined {
  if (detail.criteria.length === 0) return undefined
  if (detail.sections.some((section) => section.heading === 'Acceptance Criteria')) return undefined
  const box = document.createElement('section')
  box.className = 'board-detail-stray'
  box.append(heading('Acceptance Criteria'))
  const says = document.createElement('p')
  says.className = 'board-detail-finding'
  says.textContent = `A ${detail.level} carries no acceptance criteria, but this file has ${String(detail.criteria.length)}. Open the file to move or remove them.`
  box.append(says)
  const list = document.createElement('ul')
  list.className = 'board-detail-criteria'
  for (const criterion of detail.criteria) {
    const item = document.createElement('li')
    item.append(tag('board-detail-stray-mark', criterion.done ? '☑' : '☐'), tag('board-detail-stray-text', criterion.text))
    list.append(item)
  }
  box.append(list)
  return box
}

/**
 * Everything that validates this workitem, or — for a test — everything it
 * validates.
 *
 * One direction each way, and only one of them is ever drawn: the link lives
 * in the workitem's file, so a test only knows what points at it because the
 * whole board was read. A verdict that is not `pass` is marked failing, the
 * way a card's chip counts anything short of every check passing — an
 * unproven check is the thing worth seeing.
 * @param detail - the entity being drawn.
 * @param on - what the surface can do.
 * @returns the section, or nothing when there is nothing in either direction.
 */
function linksFor(detail: EntityDetailView, on: DetailActions): HTMLElement | undefined {
  if (detail.level === 'test') {
    if (detail.validates.length === 0) return undefined
    const box = document.createElement('section')
    box.className = 'board-detail-links'
    box.append(heading('Validates'))
    for (const one of detail.validates) {
      box.append(
        rowFor(one.name, one.result, one.result !== 'pass', () => {
          on.open(one.folderPath)
        }),
      )
    }
    return box
  }
  if (detail.links.length === 0) return undefined
  const box = document.createElement('section')
  box.className = 'board-detail-links'
  box.append(heading('Validated by'))
  for (const link of detail.links) {
    const row = rowFor(link.name, link.result, link.result !== 'pass', () => {
      on.open(link.test)
    })
    // The comment and the bug are why a failure failed, and this is the one
    // place either is visible: neither is on the card and neither is in the
    // test's own file.
    if (link.comment !== '') row.append(tag('board-detail-row-comment', link.comment))
    if (link.bug !== undefined) row.append(tag('board-detail-row-bug', link.bug))
    box.append(row)
  }
  return box
}

/**
 * One entity, as the board panel draws it in place of its columns.
 *
 * Pure: data in, DOM out, every write handed in as `on`. The order is the
 * spec's and it is octoshell's — name and status, the parent above it, the
 * description, then the level's own sections in the order the file writes
 * them, then the children, then the links. It is the order a reader wants
 * rather than the order a schema lists, and the sections keep their file
 * order including the blank ones, so the surface shows the shape of the
 * document rather than only the parts somebody has filled in.
 * @param detail - the entity, read the same way the board was.
 * @param on - what the surface can do.
 * @returns the detail, ready to put in the panel.
 */
export function renderDetail(detail: EntityDetailView, on: DetailActions): HTMLElement {
  const box = document.createElement('section')
  box.className = 'board-detail'
  box.append(headFor(detail, on))
  if (detail.parent !== undefined) {
    const line = document.createElement('p')
    line.className = 'board-detail-parent'
    const parent = detail.parent
    line.append(
      rowFor(parent.name, '', false, () => {
        on.open(parent.folderPath)
      }),
    )
    box.append(line)
  }
  box.append(detail.description === '' ? blankLine() : prose(detail.description, on))
  // A test has no status, so there is nothing for a select to write.
  if (detail.status !== '') box.append(statusFor(detail, on))
  for (const section of detail.sections) {
    box.append(heading(section.heading))
    if (section.heading === 'Acceptance Criteria') {
      box.append(criteriaFor(detail, on))
      continue
    }
    box.append(section.body.trim() === '' ? blankLine() : prose(section.body, on))
  }
  const stray = strayCriteriaFor(detail)
  if (stray !== undefined) box.append(stray)
  if (detail.children.length > 0) {
    const kids = document.createElement('section')
    kids.className = 'board-detail-children'
    kids.append(heading('Children'))
    for (const child of detail.children) {
      kids.append(
        rowFor(child.name, child.status === '' ? '' : statusLabel(child.status), false, () => {
          on.open(child.folderPath)
        }),
      )
    }
    box.append(kids)
  }
  const links = linksFor(detail, on)
  if (links !== undefined) box.append(links)
  return box
}
