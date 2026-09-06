import { BOARD_STATUSES, statusLabel } from './board-rows.ts'
import type { EntityDetailView } from './bridge.ts'
import { editField } from './edit-field.ts'
import { openMarkdownLink, renderMarkdown } from './markdown.ts'
import { statusGlyph } from './status-glyph.ts'

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
  /** Leave the detail for the surface it was opened over, which `renderDetail` is told separately. */
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
  /**
   * Save one edited prose field: the lead as `description`, or one modelled
   * section by its heading. Never a stray section — a heading the level does
   * not own patches nothing on the far side, and this surface does not offer
   * to edit one, so the two agree that malformed data is fixed in the file.
   */
  edit: (folderPath: string, patch: { description?: string; section?: { heading: string; body: string } }) => void
  /** Append one acceptance criterion, unticked; the store refuses a level that owns no criteria. */
  addCriterion: (folderPath: string, text: string) => void
  /** Declare that a test proves this workitem; a freshly declared link is unrun until something runs it. */
  linkTest: (folderPath: string, test: string, comment: string) => void
}

/**
 * The surface a back control returns to.
 *
 * The two the panel can leave a detail onto, named rather than described: the
 * columns a card was on, or the Tests list a test was picked from. It is the
 * renderer's own state and not the entity's, which is why it arrives beside
 * `EntityDetailView` rather than inside it — main has no opinion about where
 * the reader came from.
 */
export type Surface = 'columns' | 'tests'

/**
 * What back says, per surface.
 *
 * One table, read by the detail's control and by the Tests list's own, because
 * the two are the same gesture on the same panel and they were two hard-coded
 * strings that had already drifted: a test opened from Tests offered "← Board"
 * and went to Tests.
 */
const BACK_LABEL: Record<Surface, string> = { columns: '← Board', tests: '← Tests' }

/**
 * The control that leaves a surface, labelled with where it goes.
 *
 * Exported because the Tests destination draws one too, and a second copy of
 * five lines is a second place for the label and the class to drift from what
 * the stylesheet and this table say.
 * @param to - the surface it returns to.
 * @param go - what pressing it does.
 * @returns the control, ready to append.
 */
export function backButton(to: Surface, go: () => void): HTMLElement {
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'board-detail-back'
  back.textContent = BACK_LABEL[to]
  back.addEventListener('click', go)
  return back
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
 * One editable block of prose: rendered markdown to read, raw markdown to edit.
 *
 * `editField` from `./edit-field.ts` is the model here but not the tool, and the
 * difference is the read state alone. That field shows its value as plain text;
 * this surface must show it as *rendered* markdown — a Steps table read back as
 * `| a | b |` is the wall of pipes the whole file format was changed to end, and
 * the section tests pin the table, the sanitiser and the one followed link to
 * `.board-detail-prose`. So the read state is `prose` (rendered, sanitised, its
 * link handled the same way) and only the edit state is the raw textarea
 * `editField` shows throughout. That the two differ — pretty to read, raw to
 * write — is octoshell's own behaviour and is deliberate: what saves is the
 * source, and the board re-reads and re-renders it on the redraw a save brings.
 *
 * Save is on blur and only when the text changed, `editField`'s rule for
 * `editField`'s reason: this detail is re-read after every write, so a blur
 * that fired a same-value save would round-trip to main for nothing. A refusal
 * is the one write that brings no redraw, and then this control is left showing
 * what was typed rather than rebuilt from a stale copy — which is what "a
 * refusal shows inline without losing the edit" means for a body.
 * @param value - the raw markdown, shown rendered until clicked.
 * @param placeholder - what an empty field invites, and the textarea's own placeholder.
 * @param save - called once, on blur, with the new source when it differs from the last saved.
 * @param on - what the surface can do, for the one link the rendered read may follow.
 * @returns the control's root, read state showing first.
 */
function editableProse(value: string, placeholder: string, save: (next: string) => void, on: DetailActions): HTMLElement {
  const root = document.createElement('div')
  root.className = 'edit-field'
  let saved = value

  const resize = (textarea: HTMLTextAreaElement): void => {
    // Auto first, so shrinking the text shrinks the box — scrollHeight only
    // grows to fit what is there if the height is reset first.
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }

  function showEdit(): void {
    root.replaceChildren()
    const textarea = document.createElement('textarea')
    textarea.className = 'edit-field-input'
    textarea.placeholder = placeholder
    textarea.value = saved
    // Escape sets this before it swaps the DOM back, so the blur that removing a
    // focused element raises finds a field already reverted and saves nothing.
    let reverted = false
    textarea.addEventListener('input', () => resize(textarea))
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        reverted = true
        showRead(saved)
      }
    })
    textarea.addEventListener('blur', () => {
      if (reverted) return
      const next = textarea.value
      if (next !== saved) {
        saved = next
        save(next)
      }
      showRead(saved)
    })
    root.appendChild(textarea)
    resize(textarea)
    textarea.focus()
  }

  function showRead(text: string): void {
    root.replaceChildren()
    // A blank body keeps the read-only detail's own blank line, so an empty
    // section still reads as an invitation rather than a broken view — now
    // clickable, because the invitation is the whole point of it being here.
    const read = text.trim() === '' ? blankLine() : prose(text, on)
    read.classList.add('edit-field-read')
    read.tabIndex = 0
    read.setAttribute('role', 'button')
    read.addEventListener('click', (event) => {
      // A link in the rendered read is followed, not an opening to edit: its own
      // handler ran already, and a click on it must not also swap a textarea in
      // over the thing that was just clicked.
      if ((event.target as Element | null)?.closest('a') !== null) return
      showEdit()
    })
    read.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        showEdit()
      }
    })
    root.appendChild(read)
  }

  showRead(saved)
  return root
}

/**
 * The control that appends one acceptance criterion.
 *
 * `editField` in add mode, which is where this surface does use it: a criterion
 * is one line on disk — `AcceptanceCriterion` says so — so a single-line field
 * whose placeholder is the invitation and whose save is the append is exactly
 * the shape, no rendered read to want. It commits on blur or Enter and only
 * when something was typed, and the board's re-read redraws it empty again, so
 * there is no separate step that clears the box — the redraw is it.
 * @param detail - the entity being drawn.
 * @param on - what the surface can do.
 * @returns the control, ready to append under the criteria list.
 */
function addCriterionFor(detail: EntityDetailView, on: DetailActions): HTMLElement {
  const box = document.createElement('div')
  box.className = 'board-detail-add'
  box.append(
    editField({
      value: '',
      placeholder: 'Add a criterion',
      multiline: false,
      onSave: (text) => {
        const trimmed = text.trim()
        if (trimmed !== '') on.addCriterion(detail.folderPath, trimmed)
      },
    }),
  )
  return box
}

/**
 * The control that declares a test proves this workitem.
 *
 * Two fields and a submit rather than `editField`'s one value, because a link
 * is a pairing and not a line of prose: the test's own folder path, and a
 * comment saying why. The comment may be empty — the store allows it — but the
 * path may not, so an empty path submits nothing. No verdict is asked for: a
 * freshly declared link is `not_run` until something runs it, which main fixes.
 * @param detail - the workitem being drawn.
 * @param on - what the surface can do.
 * @returns the control, ready to append under the Validated-by list.
 */
function addTestFor(detail: EntityDetailView, on: DetailActions): HTMLElement {
  const form = document.createElement('form')
  form.className = 'board-detail-add-test'
  const test = document.createElement('input')
  test.type = 'text'
  test.className = 'board-detail-add-input'
  test.placeholder = 'Test folder path'
  const comment = document.createElement('input')
  comment.type = 'text'
  comment.className = 'board-detail-add-input'
  comment.placeholder = 'Why, if worth saying'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'board-detail-add-button'
  submit.textContent = 'Add test'
  form.append(test, comment, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const path = test.value.trim()
    if (path === '') return
    on.linkTest(detail.folderPath, path, comment.value.trim())
  })
  return form
}

/**
 * The linked documents a campaign or a mission carries.
 *
 * Read-only, and that is a stated gap rather than an oversight: a document
 * lives in a `documents:` frontmatter key, and the bridge's `updateBoardEntity`
 * patches `description`, `notes` and one section — it has no documents seam.
 * Reaching around the store with a filesystem write of our own is the one thing
 * this surface never does, so the list is shown and an attach control is not;
 * attaching a document waits on a store write of its own. Drawn only for the
 * two levels that own the key, since every other level carries `[]` and a
 * heading over nothing would read as a field the file failed to fill rather
 * than one it never has.
 * @param detail - the entity being drawn.
 * @returns the section, or nothing for a level that owns no documents.
 */
function documentsFor(detail: EntityDetailView): HTMLElement | undefined {
  if (detail.level !== 'campaign' && detail.level !== 'mission') return undefined
  const box = document.createElement('section')
  box.className = 'board-detail-docs'
  box.append(heading('Documents'))
  if (detail.documents.length === 0) {
    box.append(blankLine())
    return box
  }
  for (const doc of detail.documents) {
    const row = document.createElement('div')
    row.className = 'board-detail-doc'
    row.append(tag('board-detail-doc-label', doc.label))
    row.append(tag('board-detail-doc-target', doc.target))
    box.append(row)
  }
  return box
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
 * @param status - the row's own status, when its entity carries one. A
 *   parent line and a link/validates row point at a workitem that has no
 *   status field on the wire at all, so they pass nothing rather than `''`;
 *   only a child row carries the field, and only then is a glyph drawn.
 * @returns the row, ready to append.
 */
function rowFor(name: string, note: string, failing: boolean, go: () => void, status?: string): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'board-detail-row'
  if (status !== undefined && status !== '') row.append(statusGlyph(status))
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
 * @param under - the surface back returns to, which only the panel knows.
 * @returns the header, ready to append.
 */
function headFor(detail: EntityDetailView, on: DetailActions, under: Surface): HTMLElement {
  const head = document.createElement('div')
  head.className = 'board-detail-head'
  head.append(backButton(under, on.back))
  const title = document.createElement('h2')
  title.className = 'board-detail-title'
  title.textContent = detail.name
  head.append(title)
  // A test has no status at all, so it gets no pill: an empty one would read
  // as a status the file failed to say rather than as one it never has.
  if (detail.status !== '') {
    const pill = tag('board-detail-status', statusLabel(detail.status))
    pill.prepend(statusGlyph(detail.status))
    head.append(pill)
  }
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
 * The glyph beside the label is a static read of `detail.status` at draw
 * time, not a control bound to the select: it says what the file currently
 * holds, and a pick not yet confirmed by main has not changed that yet
 * either. The redraw that follows a write is what moves it, same as the
 * label text already does.
 * @param detail - the entity being drawn.
 * @param on - what the surface can do.
 * @returns the labelled select, ready to append.
 */
function statusFor(detail: EntityDetailView, on: DetailActions): HTMLElement {
  const field = document.createElement('label')
  field.className = 'board-detail-field'
  const label = document.createElement('span')
  label.append(statusGlyph(detail.status), document.createTextNode('Status'))
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
 * The line that says a section is in the wrong place.
 *
 * `strayCriteriaFor`'s sentence, one field over and for the same reason: the
 * board's rule for malformed data is that it is reported rather than repaired
 * or hidden, and the file is the only place it can be fixed. The prose itself
 * still follows — a finding that named the heading and swallowed what was
 * under it would hide the thing it is complaining about.
 * @param level - what the entity is, since that is what does not own the section.
 * @param heading - the section that ended up here.
 * @returns the line, ready to append.
 */
function sectionFinding(level: string, heading: string): HTMLElement {
  const says = document.createElement('p')
  says.className = 'board-detail-finding'
  says.textContent = `A ${level} has no ${heading} section, but this file has one. Open the file to move or remove it.`
  return says
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
  // Only a campaign, a mission or a task declares what proves it — `linkTest`
  // refuses every other level — so those are the levels that draw the section
  // and its add control even before the first link, which is how the first one
  // is added. A bug is not one of them: it carries no links and gets no control
  // that would only ever offer a write the store comes back refusing.
  const workitem = detail.level === 'campaign' || detail.level === 'mission' || detail.level === 'task'
  if (!workitem && detail.links.length === 0) return undefined
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
  if (workitem) box.append(addTestFor(detail, on))
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
 * @param under - the surface back returns to. Passed in rather than assumed,
 *   because it is the one thing the detail says that lives in the panel's own
 *   state and not in the entity: `back` is a callback and a callback cannot be
 *   asked where it goes, so a label written here could only ever guess.
 * @returns the detail, ready to put in the panel.
 */
export function renderDetail(detail: EntityDetailView, on: DetailActions, under: Surface): HTMLElement {
  const box = document.createElement('section')
  box.className = 'board-detail'
  box.append(headFor(detail, on, under))
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
  // The lead is editable prose: click it and it becomes the raw markdown in a
  // textarea, and the save is a `description` patch.
  box.append(
    editableProse(detail.description, 'Describe this', (next) => {
      on.edit(detail.folderPath, { description: next })
    }, on),
  )
  // A test has no status, so there is nothing for a select to write.
  if (detail.status !== '') box.append(statusFor(detail, on))
  for (const section of detail.sections) {
    box.append(heading(section.heading))
    if (section.heading === 'Acceptance Criteria') {
      box.append(criteriaFor(detail, on))
      box.append(addCriterionFor(detail, on))
      continue
    }
    if (section.stray === true) {
      // A stray section stays read-only. It is a section this level does not
      // own, drawn under a finding because the file is the only place it can be
      // fixed; making it editable here would write the malformed body back
      // through a save — which patches nothing for a heading the level does not
      // own anyway — as if it belonged, the exact repair the board's rule for
      // malformed data refuses to make. A section this level does not own carries
      // no blank case either: main sends it only when it has content.
      box.append(sectionFinding(detail.level, section.heading))
      box.append(section.body.trim() === '' ? blankLine() : prose(section.body, on))
      continue
    }
    // A modelled section the level owns is editable, the same way the lead is,
    // saving one `section` patch named by its heading.
    box.append(
      editableProse(section.body, `Add ${section.heading.toLowerCase()}`, (next) => {
        on.edit(detail.folderPath, { section: { heading: section.heading, body: next } })
      }, on),
    )
  }
  const stray = strayCriteriaFor(detail)
  if (stray !== undefined) box.append(stray)
  const docs = documentsFor(detail)
  if (docs !== undefined) box.append(docs)
  if (detail.children.length > 0) {
    const kids = document.createElement('section')
    kids.className = 'board-detail-children'
    kids.append(heading('Children'))
    for (const child of detail.children) {
      kids.append(
        rowFor(
          child.name,
          child.status === '' ? '' : statusLabel(child.status),
          false,
          () => {
            on.open(child.folderPath)
          },
          child.status,
        ),
      )
    }
    box.append(kids)
  }
  const links = linksFor(detail, on)
  if (links !== undefined) box.append(links)
  return box
}
