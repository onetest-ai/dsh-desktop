// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { type DetailActions, renderDetail, type Surface } from './board-detail.ts'
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
 * @param under - the surface back returns to; the columns unless a case is about it.
 */
function show(view: EntityDetailView, on: DetailActions, under: Surface = 'columns'): void {
  document.body.innerHTML = ''
  document.body.append(renderDetail(view, on, under))
}

describe('the detail view', () => {
  it('heads with the entity’s name and its status', () => {
    show(detail(), actions())
    expect(document.querySelector('.board-detail-title')?.textContent).toBe('Fix the login timeout')
    expect(document.querySelector('.board-detail-status')?.textContent).toBe('Executing')
  })

  // reason: a card and its opened detail are the same status, and the reader
  // should not have to learn a second visual language to see that.
  it('puts the status glyph on the header pill, matching the status', () => {
    show(detail({ status: 'done' }), actions())
    const glyph = document.querySelector('.board-detail-status .status-glyph')
    expect(glyph).not.toBeNull()
    expect(glyph?.classList.contains('status-glyph-done')).toBe(true)
  })

  // reason: a test's detail has no status at all — the pill is never drawn,
  // so there is nothing here for a glyph to sit in either, and drawing one
  // anyway would be the exact claim the missing pill is there to avoid.
  it('draws no header glyph for a test, and does not throw', () => {
    expect(() => show(detail({ level: 'test', status: '', parent: undefined }), actions())).not.toThrow()
    expect(document.querySelector('.board-detail-status .status-glyph')).toBeNull()
    expect(document.querySelector('.board-detail .status-glyph')).toBeNull()
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

  // reason: the label used to be a constant here, because `back` is a callback
  // and a callback cannot be asked where it goes — so a test opened from the
  // Tests list offered "← Board" and went to Tests. The destination is the
  // panel's own state, so it has to arrive with the entity.
  it('labels back with the surface it was told back returns to', () => {
    show(detail(), actions(), 'tests')
    expect(document.querySelector('.board-detail-back')?.textContent).toBe('← Tests')
    show(detail(), actions(), 'columns')
    expect(document.querySelector('.board-detail-back')?.textContent).toBe('← Board')
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

  // reason: the select's own label carries the same glyph the card and the
  // header pill do, so a reader who only glances at the field still sees
  // what it currently holds — not wired to the select's own change, which
  // Task 3 leaves for the next redraw rather than a live listener.
  it('puts the status glyph beside the select’s label, for the current value', () => {
    show(detail({ status: 'validation' }), actions())
    const field = document.querySelector('.board-detail-field')
    const glyph = field?.querySelector('.status-glyph')
    expect(glyph).not.toBeNull()
    expect(glyph?.classList.contains('status-glyph-validation')).toBe(true)
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
    expect(row?.querySelector('.status-glyph-idea')).not.toBeNull()
    row?.click()
    expect(on.calls).toContainEqual(['open', 'campaigns/q3/missions/m1/tasks/t2'])
  })

  // reason: the wire's `EntityDetailView` gives a parent line only a
  // folder path and a name — no status field to read — so the row must not
  // reach for one that is not there, and must not throw doing it.
  it('draws no glyph on the parent row, which carries no status', () => {
    expect(() => show(detail(), actions())).not.toThrow()
    const parentRow = document.querySelector<HTMLElement>('.board-detail-parent .board-detail-row')
    expect(parentRow?.querySelector('.status-glyph')).toBeNull()
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

  // reason: a test's Test Data table is the case the whole format change was
  // made for, and it can be wider than the detail's 68ch measure — which the
  // CSS above it asserts nothing is. Without a scroll box of its own it widens
  // the panel's own horizontal scroll instead. jsdom lays nothing out, so the
  // stylesheet is the only place a test can read this.
  it('gives a table in the prose its own horizontal scroll', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(import.meta.dirname, '..', 'pane.css'), 'utf8')
    const match = css.match(/\.board-detail-prose table\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    expect(match?.[1]).toMatch(/overflow-x\s*:\s*auto/)
    // `overflow` does nothing on a `table` box, so the pair is the fix and
    // either half alone is not.
    expect(match?.[1]).toMatch(/display\s*:\s*block/)
  })

  // reason: the level that does own the section draws them there and only
  // there — a second copy under the finding would read as two lists.
  it('draws no stray block when the level owns the section', () => {
    show(detail(), actions())
    expect(document.querySelector('.board-detail-stray')).toBeNull()
  })

  // reason: `## Target` on a task is written back by every save and was drawn
  // nowhere, so the file held prose the only surface built to read it hid.
  // The spec's rule for a section a level does not own is the rule for stray
  // criteria one field over: reported, never repaired and never hidden.
  it('draws a section the level does not own under a finding, with its prose', () => {
    show(
      detail({
        criteria: [],
        sections: [
          { heading: 'Notes', body: '' },
          { heading: 'Target', body: 'Ship **it**.', stray: true },
        ],
      }),
      actions(),
    )
    const finding = document.querySelector('.board-detail-finding')
    expect(finding?.textContent).toContain('Target')
    expect(finding?.textContent).toContain('task')
    // The prose is still prose: it is the content the reader came for, and a
    // finding that showed only the heading would name a problem and hide it.
    expect(document.querySelector('.board-detail-prose strong')?.textContent).toBe('it')
  })

  // reason: the finding is about where the section sits, so it goes with the
  // section rather than at the foot of the surface — and the level's own
  // sections carry none, or every heading would read as a complaint.
  it('draws no finding beside the level’s own sections', () => {
    show(detail({ criteria: [], sections: [{ heading: 'Notes', body: 'Fine.' }] }), actions())
    expect(document.querySelector('.board-detail-finding')).toBeNull()
  })
})
