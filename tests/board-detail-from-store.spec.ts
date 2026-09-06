// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detailFor } from '../src/main/board-ipc'
import { type DetailActions, renderDetail } from '../src/renderer/pane/board-detail.ts'
import type { EntityDetailView } from '../src/renderer/pane/bridge.ts'

/**
 * The detail view drawn from a file, rather than from a hand-built view.
 *
 * `board-detail.spec.ts` builds its `sections` array by hand, which is the
 * right shape for a renderer test and is exactly why a regression got through:
 * a fixture written by a human cannot go stale when `sectionsOf` changes what
 * it produces, so the renderer test and the store test agreed with each other
 * about a shape main had stopped emitting. This file joins the two ends —
 * a file on disk, read by `detailFor`, drawn by `renderDetail` — so what is
 * asserted is what a reader would actually see.
 *
 * It lives here rather than beside either module because the renderer must not
 * import from `src/main/`, and a spec under `src/renderer/pane/` is inside the
 * face that rule protects (and inside `tsconfig.pane.json`'s own include).
 * Neutral ground is the only place both halves can meet.
 */
let project = ''
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-detail-store-')))
  mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Write one board file.
 * @param path - the path within `.dsh/tasks/`.
 * @param body - the file's text.
 */
function put(path: string, body: string): void {
  const full = join(project, '.dsh', 'tasks', path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
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
 * Read one entity and draw it, the way the panel does.
 * @param folderPath - the entity's path within the board.
 * @returns the recording actions, for a case that presses something.
 */
function draw(folderPath: string): DetailActions & { calls: unknown[][] } {
  const detail = detailFor(project, folderPath)
  expect(detail).toBeDefined()
  const on = actions()
  document.body.innerHTML = ''
  document.body.append(renderDetail(detail as unknown as EntityDetailView, on, 'columns'))
  return on
}

describe('a detail drawn from the file the store read', () => {
  // reason: a bug owns no acceptance criteria — `tickCriterion` refuses a tick
  // at that level — so criteria in its file are malformed data, and the rule
  // for malformed data is that it is reported rather than hidden or repaired.
  // Checkboxes here would be a control that always answers with a refusal.
  it('draws a bug’s stray criteria read-only, under a finding', () => {
    put('campaigns/q3/workitem.md', '---\nname: Q3\nsubtype: campaign\nstatus: executing\n---\n')
    put(
      'campaigns/q3/bugs/b1/bug.md',
      '---\nname: B1\nstatus: backlog\n---\n\nIt broke.\n\n## Acceptance Criteria\n\n- [x] It holds\n- [ ] It logs\n',
    )
    expect(detailFor(project, 'campaigns/q3/bugs/b1')!.criteria).toEqual([
      { text: 'It holds', done: true },
      { text: 'It logs', done: false },
    ])
    draw('campaigns/q3/bugs/b1')
    expect(document.querySelectorAll('.board-detail-tick').length).toBe(0)
    const stray = document.querySelector('.board-detail-stray')
    expect(stray?.textContent).toContain('It holds')
    expect(stray?.textContent).toContain('It logs')
    const finding = stray?.querySelector('.board-detail-finding')?.textContent ?? ''
    expect(finding).toContain('bug')
    expect(finding).toContain('2')
    // One report, not two: the section loop must not also draw its own
    // finding for the same heading.
    expect(document.querySelectorAll('.board-detail-finding').length).toBe(1)
  })

  // reason: the spec is explicit that a test is a criterion made executable
  // and carries none of its own, so the same rule holds one level over.
  it('draws a test’s stray criteria read-only, under a finding', () => {
    put('tests/login/test.md', '---\nname: Login\n---\n\nProves sign-in.\n\n## Acceptance Criteria\n\n- [ ] It holds\n')
    draw('tests/login')
    expect(document.querySelectorAll('.board-detail-tick').length).toBe(0)
    const stray = document.querySelector('.board-detail-stray')
    expect(stray?.textContent).toContain('It holds')
    expect(stray?.querySelector('.board-detail-finding')?.textContent).toContain('test')
  })

  // reason: the levels that do own the section still draw the checkboxes
  // there, so this pair is what says the fix narrowed nothing but the levels
  // it was about — and the tick still carries the criterion's own index.
  it('still ticks a task’s own criteria, drawn where the file puts them', () => {
    put('campaigns/q3/workitem.md', '---\nname: Q3\nsubtype: campaign\nstatus: executing\n---\n')
    put(
      'campaigns/q3/missions/m1/workitem.md',
      '---\nname: M1\nsubtype: mission\nstatus: executing\n---\n',
    )
    put(
      'campaigns/q3/missions/m1/tasks/t1/workitem.md',
      '---\nname: T1\nsubtype: task\nstatus: executing\n---\n\n## Acceptance Criteria\n\n- [x] It holds\n- [ ] It logs\n',
    )
    const on = draw('campaigns/q3/missions/m1/tasks/t1')
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.board-detail-tick')]
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
    expect(document.querySelector('.board-detail-stray')).toBeNull()
    expect(document.querySelector('.board-detail-finding')).toBeNull()
    boxes[1].checked = true
    boxes[1].dispatchEvent(new Event('change'))
    expect(on.calls).toContainEqual(['tick', 'campaigns/q3/missions/m1/tasks/t1', 1, true])
  })
})
