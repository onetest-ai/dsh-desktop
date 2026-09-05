import { BOARD_STATUSES, statusLabel } from './board-rows.ts'
import type { EntityDetailView } from './bridge.ts'
import { renderMarkdown } from './markdown.ts'

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
 * @param text - the markdown source.
 * @returns the rendered block, ready to append.
 */
function prose(text: string): HTMLElement {
  const node = document.createElement('div')
  node.className = 'board-detail-prose'
  node.innerHTML = renderMarkdown(text)
  return node
}

/**
 * A small dimmed tag, as a card's own tags are drawn.
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
  box.append(detail.description === '' ? blankLine() : prose(detail.description))
  // A test has no status, so there is nothing for a select to write.
  if (detail.status !== '') box.append(statusFor(detail, on))
  for (const section of detail.sections) {
    box.append(heading(section.heading))
    if (section.heading === 'Acceptance Criteria') {
      box.append(criteriaFor(detail, on))
      continue
    }
    box.append(section.body.trim() === '' ? blankLine() : prose(section.body))
  }
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
