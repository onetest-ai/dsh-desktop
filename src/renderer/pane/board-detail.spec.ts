// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { type DetailActions, renderDetail } from './board-detail.ts'
import type { EntityDetailView } from './bridge.ts'

/**
 * One entity's detail, with only what a case names.
 *
 * Shaped as a task, since that is the entity a card is most often about, and
 * every case overrides the one field it is asking about — what a case is for
 * should be the difference between it and this, not the fixture it had to
 * build to get there.
 * @param over - what this case is about.
 * @returns the detail, as `readTaskDetail` answers it.
 */
function detail(over: Partial<EntityDetailView> = {}): EntityDetailView {
  return {
    level: 'task',
    folderPath: 'campaigns/q3/missions/m1/tasks/t1',
    name: 'Fix the login timeout',
    status: 'executing',
    parent: { folderPath: 'campaigns/q3/missions/m1', name: 'M1' },
    description: 'The session dies at ten minutes.',
    sections: [
      { heading: 'Acceptance Criteria', body: '- [x] It holds\n- [ ] It logs' },
      { heading: 'Notes', body: '' },
    ],
    criteria: [
      { text: 'It holds', done: true },
      { text: 'It logs', done: false },
    ],
    children: [],
    links: [],
    validates: [],
    file: 'workitem.md',
    ...over,
  }
}

/** Every action, recorded rather than performed. */
function actions(): DetailActions & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    back: () => calls.push(['back']),
    open: (folderPath) => calls.push(['open', folderPath]),
    openFile: (folderPath, file) => calls.push(['file', folderPath, file]),
    setStatus: (folderPath, status) => calls.push(['status', folderPath, status]),
    tick: (folderPath, index, done) => calls.push(['tick', folderPath, index, done]),
    openLink: (url) => calls.push(['link', url]),
  }
}

/**
 * Draw one detail into the document, so it can be queried as the panel's is.
 * @param view - the entity to draw.
 * @param on - the recording actions.
 */
function show(view: EntityDetailView, on: DetailActions): void {
  document.body.innerHTML = ''
  document.body.append(renderDetail(view, on))
}

describe('the detail view', () => {
  it('heads with the entity’s name and its status', () => {
    show(detail(), actions())
    expect(document.querySelector('.board-detail-title')?.textContent).toBe('Fix the login timeout')
    expect(document.querySelector('.board-detail-status')?.textContent).toBe('Executing')
  })

  // reason: the parent is where back would take you if the detail were the
  // board — an entity that has none must not draw a line pointing at nothing.
  it('draws the parent line, and omits it when there is no parent', () => {
    const on = actions()
    show(detail(), on)
    expect(document.querySelector('.board-detail-parent')?.textContent).toContain('M1')
    document.querySelector<HTMLElement>('.board-detail-parent .board-detail-row')?.click()
    expect(on.calls).toContainEqual(['open', 'campaigns/q3/missions/m1'])
    show(detail({ level: 'campaign', parent: undefined }), actions())
    expect(document.querySelector('.board-detail-parent')).toBeNull()
  })

  // reason: the detail replaces the columns, so without this the board is
  // gone and there is nothing on the surface that says how to get it back.
  it('calls back once when the back control is pressed', () => {
    const on = actions()
    show(detail(), on)
    document.querySelector<HTMLElement>('.board-detail-back')?.click()
    expect(on.calls).toEqual([['back']])
  })

  // reason: this is the whole reason the file format changed. A test's Steps
  // table stored as `| a | b |` and drawn as text is the wall of pipes the
  // user complained about, one format later.
  it('renders a section’s body as markdown, so a table is a table', () => {
    show(
      detail({ sections: [{ heading: 'Steps', body: '| a | b |\n| --- | --- |\n| 1 | 2 |' }] }),
      actions(),
    )
    expect(document.querySelector('.board-detail-prose table')).not.toBeNull()
    expect(document.querySelectorAll('.board-detail-prose td').length).toBe(2)
  })

  // reason: a heading over an empty gap reads as a view that broke. The
  // heading is kept either way, because a section the detail dropped would be
  // a field of the document the reader never learns exists.
  it('draws a blank section as its heading and a line saying so', () => {
    show(detail({ sections: [{ heading: 'Notes', body: '' }] }), actions())
    expect([...document.querySelectorAll('.board-detail-heading')].map((node) => node.textContent)).toContain('Notes')
    expect(document.querySelector('.board-detail-blank')?.textContent).toContain('Nothing here yet')
  })

  // reason: the select is a label the reader reads and a value the store
  // writes, and they are not the same string — `validation` is the file's
  // word and Validation is the reader's.
  it('offers the five statuses by their labels and writes the raw value', () => {
    const on = actions()
    show(detail(), on)
    const select = document.querySelector<HTMLSelectElement>('.board-detail-select')
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual([
      'Idea',
      'Backlog',
      'Executing',
      'Validation',
      'Done',
    ])
    expect(select?.value).toBe('executing')
    if (select !== null && select !== undefined) select.value = 'done'
    select?.dispatchEvent(new Event('change'))
    expect(on.calls).toContainEqual(['status', 'campaigns/q3/missions/m1/tasks/t1', 'done'])
  })

  // reason: silently drawing an unknown status as `idea` would make the
  // select claim the file says something it does not — and the next change of
  // any other field would write that claim into it.
  it('keeps a status the board has no column for in the select', () => {
    show(detail({ status: 'blocked' }), actions())
    const select = document.querySelector<HTMLSelectElement>('.board-detail-select')
    expect(select?.value).toBe('blocked')
  })

  // reason: a test has no status, so a select over it would offer to write
  // one — and a pill on the heading would read as one the file failed to say.
  it('offers no status at all for a test', () => {
    show(detail({ level: 'test', status: '', parent: undefined }), actions())
    expect(document.querySelector('.board-detail-select')).toBeNull()
    expect(document.querySelector('.board-detail-status')).toBeNull()
  })

  // reason: the index is what the store ticks by, and it is the criterion's
  // position in the list — a checkbox that sent the wrong one would tick a
  // line the user never looked at.
  it('ticks a criterion by its own index', () => {
    const on = actions()
    show(detail(), on)
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.board-detail-tick')]
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
    boxes[1].checked = true
    boxes[1].dispatchEvent(new Event('change'))
    expect(on.calls).toContainEqual(['tick', 'campaigns/q3/missions/m1/tasks/t1', 1, true])
  })

  // reason: children are rows and a row opens that entity's detail, so the
  // surface navigates into itself rather than into a second window.
  it('opens a child’s own detail from its row', () => {
    const on = actions()
    show(
      detail({
        level: 'mission',
        children: [{ level: 'task', folderPath: 'campaigns/q3/missions/m1/tasks/t2', name: 'T2', status: 'idea' }],
      }),
      on,
    )
    const row = document.querySelector<HTMLElement>('.board-detail-children .board-detail-row')
    expect(row?.textContent).toContain('T2')
    row?.click()
    expect(on.calls).toContainEqual(['open', 'campaigns/q3/missions/m1/tasks/t2'])
  })

  // reason: this is where a failing check is explained, and it is the reason
  // the link lives in the workitem rather than in the test. A verdict short
  // of `pass` reads as failing, the way a card's chip does.
  it('lists what validates it, marking a failure as the card’s chip does', () => {
    const on = actions()
    show(
      detail({
        links: [{ test: 'tests/login', name: 'Login holds', result: 'fail', comment: 'timed out', bug: 'campaigns/q3/bugs/b1' }],
      }),
      on,
    )
    const row = document.querySelector<HTMLElement>('.board-detail-links .board-detail-row')
    expect(row?.textContent).toContain('Login holds')
    expect(row?.textContent).toContain('fail')
    expect(row?.querySelector('.board-chip-failing')).not.toBeNull()
    expect(row?.textContent).toContain('timed out')
    row?.click()
    expect(on.calls).toContainEqual(['open', 'tests/login'])
  })

  // reason: the reverse direction exists nowhere in the test's own file, so
  // this is the only surface that can show it.
  it('lists what a test validates, from the test’s own detail', () => {
    const on = actions()
    show(
      detail({
        level: 'test',
        status: '',
        parent: undefined,
        validates: [{ folderPath: 'campaigns/q3/missions/m1/tasks/t1', name: 'T1', result: 'pass' }],
      }),
      on,
    )
    const row = document.querySelector<HTMLElement>('.board-detail-links .board-detail-row')
    expect(document.querySelector('.board-detail-links .board-detail-heading')?.textContent).toBe('Validates')
    expect(row?.textContent).toContain('T1')
    row?.click()
    expect(on.calls).toContainEqual(['open', 'campaigns/q3/missions/m1/tasks/t1'])
  })

  // reason: the detail is read, and Open file is the way out of that into the
  // editor. The file comes from the read rather than from the level, so a
  // board nobody has converted still opens the `.yaml` that is actually there.
  it('hands the editor the file the read named', () => {
    const on = actions()
    show(detail({ file: 'bug.md' }), on)
    document.querySelector<HTMLElement>('.board-detail-file')?.click()
    expect(on.calls).toContainEqual(['file', 'campaigns/q3/missions/m1/tasks/t1', 'bug.md'])
  })

  // reason: this surface inserts markdown with `innerHTML`, which is only
  // safe because `renderMarkdown` sanitises first — and this page holds the
  // preload that reaches the filesystem, so a handler surviving into the DOM
  // here would run with that access, on a file an agent wrote.
  it('sanitises a section body rather than trusting the file', () => {
    show(
      detail({ sections: [{ heading: 'Notes', body: '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>' }] }),
      actions(),
    )
    // The last block, since the description above it is prose as well.
    const prose = [...document.querySelectorAll('.board-detail-prose')].pop()
    expect(prose?.querySelector('img')).not.toBeNull()
    expect(prose?.querySelector('img')?.getAttribute('onerror')).toBeNull()
    expect(prose?.querySelector('script')).toBeNull()
    expect(prose?.innerHTML).not.toContain('onerror')
  })

  // reason: the sanitiser keeps an `<a href>` — it has to, a link is content —
  // so the click is the other half of what makes this insertion safe. This
  // page holds the preload that reaches the filesystem, and following a link
  // in place would put a page an agent's markdown named where that preload
  // is, with no back control on the view to undo it.
  it('hands an http link to the browser rather than following it in place', () => {
    const on = actions()
    show(detail({ sections: [{ heading: 'Notes', body: '[the RFC](https://example.com/rfc)' }] }), on)
    const link = [...document.querySelectorAll<HTMLElement>('.board-detail-prose a')].pop()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link?.dispatchEvent(click)
    expect(on.calls).toContainEqual(['link', 'https://example.com/rfc'])
    expect(click.defaultPrevented).toBe(true)
  })

  // reason: a relative link names a place inside the project, which this
  // surface cannot resolve — and the failure to resolve it must be nothing
  // happening, not the renderer navigating to a path it guessed at.
  it('takes a relative link nowhere at all', () => {
    const on = actions()
    show(detail({ description: 'See [the plan](../plan.md).' }), on)
    const link = document.querySelector<HTMLElement>('.board-detail-prose a')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link?.dispatchEvent(click)
    expect(on.calls).toEqual([])
    expect(click.defaultPrevented).toBe(true)
  })

  // reason: `LEVEL_SECTIONS` gives Acceptance Criteria to a campaign, a
  // mission and a task only, so a bug carrying criteria has none of its
  // sections to draw them in — and the spec's rule for a field a level does
  // not own is that it is a finding, reported rather than hidden.
  it('reports criteria on a level whose document has no section for them', () => {
    show(
      detail({
        level: 'bug',
        sections: [{ heading: 'What Happened', body: 'It broke.' }],
        criteria: [{ text: 'It holds', done: false }],
      }),
      actions(),
    )
    const stray = document.querySelector('.board-detail-stray')
    expect(stray?.textContent).toContain('It holds')
    expect(stray?.querySelector('.board-detail-finding')?.textContent).toContain('bug')
    // Read-only: the store refuses a tick on a level that owns no criteria,
    // so a checkbox here would offer a write that always comes back refused.
    expect(document.querySelector('.board-detail-tick')).toBeNull()
  })

  // reason: the level that does own the section draws them there and only
  // there — a second copy under the finding would read as two lists.
  it('draws no stray block when the level owns the section', () => {
    show(detail(), actions())
    expect(document.querySelector('.board-detail-stray')).toBeNull()
  })
})
