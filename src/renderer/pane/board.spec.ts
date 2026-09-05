// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The panel's markup, cut to the elements the board writes into or reads by
 * name.
 *
 * `pane.html` declares more — the tab strip, the editor, the address bar —
 * but nothing else is reached by id from this module: a fuller copy here
 * would be a second description of the page that could drift from it.
 */
function page(): void {
  document.body.innerHTML =
    '<p class="empty" id="board-empty" hidden></p>' +
    '<p class="git-note" id="board-note" role="status" hidden></p>' +
    '<div id="board-groups"></div>' +
    '<div id="board-modal" class="board-modal" hidden><form id="board-modal-form">' +
    '<p id="board-modal-title"></p>' +
    '<button type="button" id="board-modal-close"></button>' +
    '<label><span>Name</span><input type="text" id="board-modal-name"></label>' +
    '<label><span id="board-modal-second-label"></span><input type="text" id="board-modal-second"></label>' +
    '<p id="board-modal-error" hidden></p>' +
    '<button type="button" id="board-modal-cancel"></button>' +
    '<button type="submit" id="board-modal-create"></button>' +
    '</form></div>'
}

/** One entity for a stub board, with only what a case names. */
function node(level: string, name: string, folderPath: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    level,
    name,
    folderPath,
    status: 'draft',
    children: [],
    progress: { done: 0, total: 0 },
    criteria: { done: 0, total: 0 },
    verdicts: { pass: 0, total: 0 },
    ...over,
  }
}

/**
 * The smallest board with something on it: one campaign, one mission, one task.
 *
 * Every case reads the same three names, so what a case is about is the one
 * option it passes rather than the shape it had to build to get there.
 * @param over - the task's status and verdicts, and the read's findings.
 * @returns the board, as `readTasks` answers it.
 */
function oneMission(
  over: {
    taskStatus?: string
    verdicts?: { pass: number; total: number }
    findings?: { folderPath: string; says: string }[]
  } = {},
): Record<string, unknown> {
  const task = node('task', 'T1', 'campaigns/q3/missions/m1/tasks/t1', {
    status: over.taskStatus ?? 'draft',
    verdicts: over.verdicts ?? { pass: 0, total: 0 },
  })
  return {
    present: true,
    campaigns: [
      node('campaign', 'Q3', 'campaigns/q3', {
        children: [node('mission', 'M1', 'campaigns/q3/missions/m1', { children: [task] })],
      }),
    ],
    tests: { path: 'tests', slug: 'tests', suites: [], tests: [] },
    findings: over.findings ?? [],
  }
}

/** What one board write answered with. */
type StubResult = { ok: true } | { ok: false; reason: string }

/** The stub bridge, with everything the board asks of it and what it recorded. */
interface Stub {
  readTasks: () => Promise<unknown>
  onTasksChanged: (listener: () => void) => void
  onReveal: (listener: (folderPath: string) => void) => void
  revealOnBoard: (folderPath: string) => void
  openTaskFile: (folderPath: string, file: string) => void
  createBoardEntity: (level: string, parent: string, name: string, second: string) => Promise<StubResult>
  setBoardStatus: (folderPath: string, status: string) => Promise<StubResult>
  trashBoardEntity: (folderPath: string) => Promise<StubResult>
  askTheme: () => void
  onTheme: () => void
  /**
   * Every call the board made, named and in order.
   *
   * One list rather than one per method: the drop rule is about how many
   * writes one gesture makes, which separate lists cannot say.
   */
  calls: unknown[][]
  /** Fire the `tasks:changed` listener, as main would after a write. */
  fire: () => void
  /** Fire the reveal listener, as main would when the tree names a folder. */
  reveal: (folderPath: string) => void
}

/**
 * A bridge answering with one board and recording the writes the board makes.
 * @param data - what `readTasks` answers.
 * @param answers - what a write answers, when the case is about a refusal.
 * @returns the bridge, with its recordings.
 */
function bridge(data: Record<string, unknown>, answers: { status?: StubResult; create?: StubResult; trash?: StubResult } = {}): Stub {
  const calls: unknown[][] = []
  let changed: (() => void) | undefined
  let revealed: ((folderPath: string) => void) | undefined
  return {
    calls,
    readTasks: async () => data,
    onTasksChanged: (listener) => {
      changed = listener
    },
    onReveal: (listener) => {
      revealed = listener
    },
    fire: () => changed?.(),
    reveal: (folderPath) => revealed?.(folderPath),
    revealOnBoard: (folderPath) => calls.push(['reveal', folderPath]),
    openTaskFile: (folderPath, file) => calls.push(['open', folderPath, file]),
    createBoardEntity: async (level, parent, name, second) => {
      calls.push(['create', level, parent, name, second])
      return answers.create ?? { ok: true }
    },
    setBoardStatus: async (folderPath, status) => {
      calls.push(['status', folderPath, status])
      return answers.status ?? { ok: true }
    },
    trashBoardEntity: async (folderPath) => {
      calls.push(['trash', folderPath])
      return answers.trash ?? { ok: true }
    },
    askTheme: () => {},
    onTheme: () => {},
  }
}

/**
 * Load the board against a stub bridge.
 *
 * The module reads once as it loads, so it is imported per test rather than
 * once for the file.
 * @param stub - the bridge the board talks to.
 * @returns resolution once that first read has been drawn.
 */
async function load(stub: Stub): Promise<void> {
  ;(globalThis as unknown as { pane: unknown }).pane = stub
  vi.resetModules()
  await import('./board.ts')
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/**
 * Drag one card into one column, as a pointer would.
 *
 * jsdom implements no drag at all — no `DragEvent`, no `dataTransfer` — so
 * every event is built here and the transfer is a plain object with the two
 * methods a handler calls on it.
 *
 * The columns between the card and its destination are dragged over on the
 * way, because that is what a pointer does: a card cannot reach the sixth
 * column without crossing the four before it, and the whole point of the drop
 * rule is that crossing writes nothing.
 * @param folderPath - the card's folder path, which the drag carries.
 * @param status - the column to drop it in.
 */
function drop(folderPath: string, status: string): void {
  const card = document.querySelector<HTMLElement>(`.board-card[data-folder="${folderPath}"]`)
  const column = document.querySelector<HTMLElement>(`.board-column-${status}`)
  const crossed = [...document.querySelectorAll<HTMLElement>('.board-column')]
  let carried = ''
  const dataTransfer = {
    setData: (_kind: string, value: string) => {
      carried = value
    },
    getData: () => carried,
    effectAllowed: '',
    dropEffect: '',
  }
  const start = new Event('dragstart', { bubbles: true })
  Object.defineProperty(start, 'dataTransfer', { value: dataTransfer })
  card?.dispatchEvent(start)
  for (const over of crossed.slice(0, crossed.indexOf(column as HTMLElement) + 1)) {
    const passing = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(passing, 'dataTransfer', { value: dataTransfer })
    over.dispatchEvent(passing)
  }
  const landing = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(landing, 'dataTransfer', { value: dataTransfer })
  column?.dispatchEvent(landing)
}

beforeEach(page)

describe('the board', () => {
  it('draws a column for every status, empty ones included', async () => {
    await load(bridge(oneMission()))
    const headings = [...document.querySelectorAll('.board-column-title')].map((node) => node.textContent)
    expect(headings).toEqual(['draft', 'executing', 'awaitingApproval', 'done', 'failed', 'cancelled'])
  })

  it('puts a card in the column its status names', async () => {
    await load(bridge(oneMission({ taskStatus: 'done' })))
    expect(document.querySelector('.board-column-done .board-card')?.textContent).toContain('T1')
  })

  // reason: a test has no status, so there is no column it belongs in — the
  // workitem that names it carries a chip instead.
  it('shows a validation chip rather than a card for a test', async () => {
    await load(bridge(oneMission({ verdicts: { pass: 1, total: 2 } })))
    expect(document.querySelector('.board-chip')?.textContent).toBe('1/2 passing')
  })

  it('opens the entity’s own file when a card is clicked', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-card')?.click()
    expect(stub.calls).toContainEqual(['open', 'campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml'])
  })

  // reason: drag writes on drop. A card that changed status while dragged
  // across a column would write a status nobody chose, in a repository.
  it('sets the status of the card that was dropped, once', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    drop('campaigns/q3/missions/m1/tasks/t1', 'done')
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(stub.calls.filter((call) => call[0] === 'status')).toEqual([
      ['status', 'campaigns/q3/missions/m1/tasks/t1', 'done'],
    ])
  })

  // reason: leaving it where it was dropped would show a status that is not
  // in the file, which is the one thing this board must never do.
  it('puts a card back when the write is refused', async () => {
    const stub = bridge(oneMission(), { status: { ok: false, reason: 'git said no' } })
    await load(stub)
    drop('campaigns/q3/missions/m1/tasks/t1', 'done')
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-column-draft .board-card')?.textContent).toContain('T1')
    expect(document.getElementById('board-note')?.textContent).toContain('git said no')
  })

  // reason: the spec's acting table gives a card a delete, and the store's
  // delete moves to the trash rather than removing — so this is offered, and
  // it is confirmed, exactly as Discard in the git panel is.
  it('deletes a card through a confirmed trash', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    const card = document.querySelector<HTMLElement>('.board-card')
    card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    document.querySelector<HTMLElement>('.board-card-delete')?.click()
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(stub.calls).toContainEqual(['trash', 'campaigns/q3/missions/m1/tasks/t1'])
  })

  // reason: main answers a cancelled confirmation with an empty reason, the
  // way `git:discard` does, and an empty reason is not a refusal — it must
  // not blank the note or bury the findings count under it.
  it('leaves the findings line alone when a delete is cancelled', async () => {
    const stub = bridge(oneMission({ findings: [{ folderPath: 'campaigns/q3', says: 'bad' }] }), {
      trash: { ok: false, reason: '' },
    })
    await load(stub)
    const card = document.querySelector<HTMLElement>('.board-card')
    card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    document.querySelector<HTMLElement>('.board-card-delete')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    const note = document.getElementById('board-note')
    expect(note?.hidden).toBe(false)
    expect(note?.textContent).toContain('1')
  })

  // reason: same cancel, but on a board with no findings — the note has
  // nothing to say and must stay hidden rather than show a blank line.
  it('leaves the note hidden when a delete is cancelled on a clean board', async () => {
    const stub = bridge(oneMission(), { trash: { ok: false, reason: '' } })
    await load(stub)
    const card = document.querySelector<HTMLElement>('.board-card')
    card?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    document.querySelector<HTMLElement>('.board-card-delete')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.getElementById('board-note')?.hidden).toBe(true)
  })

  // reason: the board cannot show a finding against the entity it names — a
  // finding's entity is by definition not on the board — so it says how many
  // there are and sends the reader to the tree, which can.
  it('says how many files could not be read, and points at the tree', async () => {
    await load(bridge(oneMission({ findings: [{ folderPath: 'campaigns/q3', says: 'bad' }] })))
    const note = document.getElementById('board-note')
    expect(note?.hidden).toBe(false)
    expect(note?.textContent).toContain('1')
    expect(note?.textContent).toContain('tree')
  })

  it('reveals and highlights a lane when main asks', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    stub.reveal('campaigns/q3/missions/m1')
    expect(document.querySelector('.board-lane-revealed')).not.toBeNull()
  })
})

describe('the create modal', () => {
  it('opens from a lane’s plus, and creates a task in that mission', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-lane-add')?.click()
    ;(document.getElementById('board-modal-name') as HTMLInputElement).value = 'New thing'
    document.getElementById('board-modal-form')?.dispatchEvent(new Event('submit', { cancelable: true }))
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(stub.calls).toContainEqual(['create', 'task', 'campaigns/q3/missions/m1', 'New thing', ''])
  })

  // reason: losing a half-typed task to a stray click is small and
  // infuriating, and it is what stops someone trusting a board.
  it('does not close on a click outside it, or on Escape', async () => {
    await load(bridge(oneMission()))
    document.querySelector<HTMLElement>('.board-lane-add')?.click()
    document.getElementById('board-modal')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.getElementById('board-modal')?.hidden).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.getElementById('board-modal')?.hidden).toBe(false)
  })

  it('closes on Cancel', async () => {
    await load(bridge(oneMission()))
    document.querySelector<HTMLElement>('.board-lane-add')?.click()
    document.getElementById('board-modal-cancel')?.click()
    expect(document.getElementById('board-modal')?.hidden).toBe(true)
  })

  // reason: the close control is the keyboard's way out, so it is an ordinary
  // button and does exactly what Cancel does.
  it('closes on its close control', async () => {
    await load(bridge(oneMission()))
    document.querySelector<HTMLElement>('.board-lane-add')?.click()
    document.getElementById('board-modal-close')?.click()
    expect(document.getElementById('board-modal')?.hidden).toBe(true)
  })

  // reason: closing on a failure would throw the typed work away along with
  // the error that explained it.
  it('stays open with what was typed when the create is refused', async () => {
    const stub = bridge(oneMission(), { create: { ok: false, reason: 'name it first' } })
    await load(stub)
    document.querySelector<HTMLElement>('.board-lane-add')?.click()
    ;(document.getElementById('board-modal-name') as HTMLInputElement).value = 'Half typed'
    document.getElementById('board-modal-form')?.dispatchEvent(new Event('submit', { cancelable: true }))
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.getElementById('board-modal')?.hidden).toBe(false)
    expect((document.getElementById('board-modal-name') as HTMLInputElement).value).toBe('Half typed')
    expect(document.getElementById('board-modal-error')?.textContent).toContain('name it first')
  })
})
