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
    '<div class="board-head" id="board-head" hidden>' +
    '<button type="button" id="board-tests">Tests</button>' +
    '</div>' +
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
    status: 'idea',
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
    /** A bug filed against the campaign, which gives the group a second lane. */
    campaignBug?: boolean
    project?: string
  } = {},
): Record<string, unknown> {
  const task = node('task', 'T1', 'campaigns/q3/missions/m1/tasks/t1', {
    status: over.taskStatus ?? 'idea',
    verdicts: over.verdicts ?? { pass: 0, total: 0 },
  })
  const children: Record<string, unknown>[] = [
    node('mission', 'M1', 'campaigns/q3/missions/m1', { children: [task] }),
  ]
  if (over.campaignBug === true) children.push(node('bug', 'B1', 'campaigns/q3/bugs/b1'))
  return {
    project: over.project ?? '/p/one',
    present: true,
    campaigns: [node('campaign', 'Q3', 'campaigns/q3', { children })],
    tests: { path: 'tests', slug: 'tests', suites: [], tests: [] },
    findings: over.findings ?? [],
  }
}

/**
 * What `readTaskDetail` answers, with only what a case names.
 *
 * The folder path is filled in by the stub from whatever was asked for, so a
 * case never has to keep the two in step by hand.
 * @param over - what this case is about.
 * @returns the detail, as the panel receives it.
 */
function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    level: 'task',
    folderPath: '',
    name: 'T1',
    status: 'idea',
    description: 'What it is for.',
    sections: [],
    criteria: [],
    children: [],
    links: [],
    validates: [],
    file: 'workitem.md',
    ...over,
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
  openExternal: (url: string) => void
  readTaskDetail: (folderPath: string) => Promise<Record<string, unknown> | undefined>
  createBoardEntity: (level: string, parent: string, name: string, second: string) => Promise<StubResult>
  setBoardStatus: (folderPath: string, status: string) => Promise<StubResult>
  tickCriterion: (folderPath: string, index: number, done: boolean) => Promise<StubResult>
  trashBoardEntity: (folderPath: string, name: string) => Promise<StubResult>
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
 * @param answers - what a write answers, when the case is about a refusal, and the detail a card opens.
 * @returns the bridge, with its recordings.
 */
function bridge(
  data: Record<string, unknown>,
  answers: { status?: StubResult; create?: StubResult; trash?: StubResult; detail?: Record<string, unknown> } = {},
): Stub {
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
    openExternal: (url) => calls.push(['external', url]),
    readTaskDetail: async (folderPath) => {
      calls.push(['detail', folderPath])
      return answers.detail === undefined ? undefined : { ...answers.detail, folderPath }
    },
    createBoardEntity: async (level, parent, name, second) => {
      calls.push(['create', level, parent, name, second])
      return answers.create ?? { ok: true }
    },
    setBoardStatus: async (folderPath, status) => {
      calls.push(['status', folderPath, status])
      return answers.status ?? { ok: true }
    },
    tickCriterion: async (folderPath, index, done) => {
      calls.push(['tick', folderPath, index, done])
      return { ok: true }
    },
    trashBoardEntity: async (folderPath, name) => {
      calls.push(['trash', folderPath, name])
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
  // The headings read as labels rather than as field names — `validation` is
  // the stored value and Validation is what a column is called — while the
  // class the drop and the stylesheet address the column by keeps the word
  // the file uses.
  it('draws a column for every status, empty ones included', async () => {
    await load(bridge(oneMission()))
    const headings = [...document.querySelectorAll('.board-column-label')].map((node) => node.textContent)
    expect(headings).toEqual(['Idea', 'Backlog', 'Executing', 'Validation', 'Done'])
    expect(document.querySelectorAll('.board-column-validation').length).toBe(1)
  })

  // reason: a column used to be its raw stored value, lowercase, with nothing
  // marking which shape belongs to which status — this is the glyph that
  // fixes that, and it has to sit before the label rather than after it.
  it('marks every column heading with the status’s own glyph, before the label', async () => {
    await load(bridge(oneMission()))
    const title = document.querySelector('.board-column-validation .board-column-title')
    const glyph = title?.querySelector('.status-glyph')
    expect(glyph).not.toBeNull()
    expect((glyph as HTMLElement | null)?.dataset.status).toBe('validation')
    const label = title?.querySelector('.board-column-label')
    expect(glyph?.compareDocumentPosition(label as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  // reason: the lane tag was the last status on this surface drawn raw, so
  // one board read `Executing` as a heading and `executing` on the lane
  // beside it — the same value, two ways, a foot apart.
  it('draws a lane’s own status as a label too', async () => {
    await load(bridge(oneMission()))
    expect(document.querySelector('.board-lane-status')?.textContent).toBe('Idea')
  })

  // reason: the lane's status tag carries only a word today; the column
  // heading beside it now leads with the status's shape, and the two should
  // read as the same status rather than the lane looking bare next to it.
  it('marks the lane’s status tag with the status’s own glyph', async () => {
    await load(bridge(oneMission()))
    const glyph = document.querySelector('.board-lane-status .status-glyph')
    expect((glyph as HTMLElement | null)?.dataset.status).toBe('idea')
  })

  it('puts a card in the column its status names', async () => {
    await load(bridge(oneMission({ taskStatus: 'done' })))
    expect(document.querySelector('.board-column-done .board-card')?.textContent).toContain('T1')
  })

  // reason: the spec says a name wraps to two lines and then ellipses, and a
  // name with no space in it — a slug, a path, an identifier — has no break
  // to take. Without a rule letting it break anywhere, such a token overflows
  // the column and is cut mid-letter by `overflow: hidden`, with nothing
  // saying it was cut. jsdom lays nothing out and so can never see this: like
  // the backdrop's `pointer-events`, it is decided by CSS, and the stylesheet
  // is the only place a test can read it.
  it('lets a card’s name break so the clamp can ellipse it', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(import.meta.dirname, '..', 'pane.css'), 'utf8')
    const match = css.match(/\.board-card-name\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    expect(match?.[1]).toMatch(/overflow-wrap\s*:\s*anywhere/)
    expect(match?.[1]).not.toMatch(/white-space\s*:\s*nowrap/)
  })

  // reason: a test has no status, so there is no column it belongs in — the
  // workitem that names it carries a verdict instead, and the verdict is now
  // a coloured dot rather than a word: a failing card must not read the same
  // as one with nothing run against it yet.
  it('shows a verdict dot on a card, not a bare validation word', async () => {
    await load(bridge(oneMission({ verdicts: { pass: 1, total: 2 } })))
    const dot = document.querySelector('.board-card .verdict-dot')
    expect(dot).not.toBeNull()
    expect(dot?.classList.contains('verdict-dot-fail')).toBe(true)
    expect(document.querySelector('.board-card .board-card-verdict-count')?.textContent).toBe('1/2')
  })

  it('draws a passing dot when every verdict passed, and none when nothing has run', async () => {
    await load(bridge(oneMission({ verdicts: { pass: 2, total: 2 } })))
    expect(document.querySelector('.board-card .verdict-dot')?.classList.contains('verdict-dot-pass')).toBe(true)
    await load(bridge(oneMission({ verdicts: { pass: 0, total: 0 } })))
    expect(document.querySelector('.board-card .verdict-dot')).toBeNull()
    expect(document.querySelector('.board-card .board-card-verdict-count')).toBeNull()
  })

  // reason: the slug is the folder's own last segment — what an agent's own
  // path calls the card — and it has to sit above the human name rather than
  // beside or after it.
  it('shows the folder’s last segment as a slug above the card’s name', async () => {
    await load(bridge(oneMission()))
    const card = document.querySelector('.board-card')
    const slug = card?.querySelector('.board-card-slug')
    const name = card?.querySelector('.board-card-name')
    expect(slug?.textContent).toBe('t1')
    expect(slug?.compareDocumentPosition(name as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  // reason: the dot replaced the text chip on a card, not the type tag a bug
  // carries — the two say different things and only one of them changed.
  it('still shows a bug’s type tag beside its slug and verdict', async () => {
    await load(bridge(oneMission({ campaignBug: true })))
    const bugCard = [...document.querySelectorAll('.board-card')].find((card) => card.textContent?.includes('B1'))
    expect(bugCard?.querySelector('.board-card-kind')?.textContent).toBe('bug')
  })

  // reason: this is the complaint the whole change is about — a click used to
  // hand the editor a serialised map, and the answer to "what is this task"
  // was YAML. It asks for the detail now, and opens nothing in the editor.
  it('asks for the entity’s detail when a card is clicked, rather than opening a file', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    document.querySelector<HTMLElement>('.board-card')?.click()
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(stub.calls).toContainEqual(['detail', 'campaigns/q3/missions/m1/tasks/t1'])
    expect(stub.calls.filter((call) => call[0] === 'open')).toEqual([])
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
    expect(document.querySelector('.board-column-idea .board-card')?.textContent).toContain('T1')
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
    expect(stub.calls).toContainEqual(['trash', 'campaigns/q3/missions/m1/tasks/t1', 'T1'])
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

  // reason: with no project open there is no place to create a campaign in,
  // so the advice that names one would be pointing at nothing.
  it('words no project apart from a project with no board', async () => {
    await load(bridge({ project: undefined, present: false, campaigns: [], tests: { path: 'tests', slug: 'tests', suites: [], tests: [] }, findings: [] }))
    expect(document.getElementById('board-empty')?.textContent).toContain('No project is open')
    await load(bridge({ project: '/p/one', present: false, campaigns: [], tests: { path: 'tests', slug: 'tests', suites: [], tests: [] }, findings: [] }))
    expect(document.getElementById('board-empty')?.textContent).toContain('no board yet')
  })

  // reason: a refusal and a highlight are both about one board's paths, and
  // `campaigns/q3` exists in more than one project — a note about the project
  // that was closed would sit over the board of the one that opened.
  it('drops the refusal and the highlight when the project changes', async () => {
    const stub = bridge(oneMission(), { status: { ok: false, reason: 'git said no' } })
    await load(stub)
    drop('campaigns/q3/missions/m1/tasks/t1', 'done')
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    stub.reveal('campaigns/q3/missions/m1')
    expect(document.getElementById('board-note')?.textContent).toContain('git said no')
    stub.readTasks = async () => oneMission({ project: '/p/other' })
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.getElementById('board-note')?.hidden).toBe(true)
    expect(document.querySelector('.board-lane-revealed')).toBeNull()
  })
})

/**
 * What the tree's four kinds of row reveal.
 *
 * One case per kind, because each is a different element and only the mission
 * was ever covered: a campaign is a heading, a mission is a lane, a task or a
 * bug is a card, and a test is not on this board at all.
 */
describe('a reveal from the tree', () => {
  it('marks a mission’s own lane', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    stub.reveal('campaigns/q3/missions/m1')
    expect(document.querySelector('.board-lane-revealed')).not.toBeNull()
  })

  // reason: a campaign is a heading on this board and nothing else, so a
  // reveal that matched only lanes had nothing to mark and marked nothing.
  it('marks a campaign’s heading', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    stub.reveal('campaigns/q3')
    expect(document.querySelector('.board-group-revealed')?.textContent).toBe('Q3')
    expect(document.querySelector('.board-lane-revealed')).toBeNull()
  })

  // reason: a campaign's bug lane carries the campaign's own folder path, so
  // a match on that string alone highlights the Bugs lane for a click on the
  // campaign — a confidently wrong answer rather than a missing one.
  it('marks the heading, not the bug lane that shares its path', async () => {
    const stub = bridge(oneMission({ campaignBug: true }))
    await load(stub)
    stub.reveal('campaigns/q3')
    const titles = [...document.querySelectorAll('.board-lane-title')].map((node) => node.textContent)
    expect(titles).toContain('Bugs')
    expect(document.querySelector('.board-group-revealed')).not.toBeNull()
    expect(document.querySelector('.board-lane-revealed')).toBeNull()
  })

  // reason: the spec gives a task row its own card. Marking the lane instead
  // leaves the reader hunting a lane of thirty cards for the one they asked
  // for, which is the hunt the reveal exists to end.
  it('marks a task’s own card', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    stub.reveal('campaigns/q3/missions/m1/tasks/t1')
    const card = document.querySelector('.board-card-revealed')
    expect(card?.textContent).toContain('T1')
    expect(document.querySelector('.board-lane-revealed')).toBeNull()
  })

  it('marks a bug’s own card', async () => {
    const stub = bridge(oneMission({ campaignBug: true }))
    await load(stub)
    stub.reveal('campaigns/q3/bugs/b1')
    expect(document.querySelector('.board-card-revealed')?.textContent).toContain('B1')
  })

  // reason: the highlight has to survive the re-read a write triggers, since
  // every redraw rebuilds the DOM the mark was written into.
  it('keeps the mark across a redraw', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    stub.reveal('campaigns/q3/missions/m1/tasks/t1')
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-card-revealed')).not.toBeNull()
  })
})

/**
 * Folding a campaign or a mission: a posture the board keeps for the session.
 *
 * The state lives in the module, not the DOM, so what these turn on is that a
 * fold survives the redraw every write triggers and is keyed by the folder
 * path, not the row — folding one campaign leaves the next alone, and a project
 * change forgets all of them.
 */
describe('folding a campaign or a mission', () => {
  /**
   * Two campaigns, each with its own mission, so a per-path claim has a second
   * row to leave alone.
   * @returns the board, as `readTasks` answers it.
   */
  function twoCampaigns(): Record<string, unknown> {
    const taskA = node('task', 'TA', 'campaigns/a/missions/ma/tasks/ta')
    const taskB = node('task', 'TB', 'campaigns/b/missions/mb/tasks/tb')
    return {
      project: '/p/one',
      present: true,
      campaigns: [
        // Executing sorts above backlog, so Alpha is the first group drawn and
        // the order the cases index by is fixed.
        node('campaign', 'Alpha', 'campaigns/a', {
          status: 'executing',
          children: [node('mission', 'MA', 'campaigns/a/missions/ma', { children: [taskA] })],
        }),
        node('campaign', 'Beta', 'campaigns/b', {
          status: 'backlog',
          children: [node('mission', 'MB', 'campaigns/b/missions/mb', { children: [taskB] })],
        }),
      ],
      tests: { path: 'tests', slug: 'tests', suites: [], tests: [] },
      findings: [],
    }
  }

  // reason: the spec says a campaign folds and a folded one still says what it
  // holds — the heading and a marker, no lanes. The heading has to be a real
  // control for the keyboard to reach it, not a span with a click.
  it('folds a campaign to its heading, hiding its lanes', async () => {
    await load(bridge(oneMission()))
    const fold = document.querySelector<HTMLElement>('.board-group-fold')
    expect(fold?.tagName).toBe('BUTTON')
    expect(document.querySelector('.board-lane')).not.toBeNull()
    fold?.click()
    expect(document.querySelector('.board-lane')).toBeNull()
    expect(document.querySelector('.board-group-title')?.textContent).toBe('Q3')
    expect(document.querySelector('.board-group-fold .board-fold-chevron-collapsed')).not.toBeNull()
  })

  // reason: a mission folds the same way, and a folded lane keeps what it is —
  // its title, its status glyph, its plus — and drops only the columns, so
  // folding is putting the work down rather than losing sight of the lane.
  it('folds a mission to its header, keeping its title, glyph and plus', async () => {
    await load(bridge(oneMission()))
    const head = document.querySelector<HTMLElement>('.board-lane .board-lane-title')
    expect(head?.tagName).toBe('BUTTON')
    expect(document.querySelector('.board-column')).not.toBeNull()
    head?.click()
    expect(document.querySelector('.board-column')).toBeNull()
    expect(document.querySelector('.board-lane-name')?.textContent).toBe('M1')
    expect(document.querySelector('.board-lane-status .status-glyph')).not.toBeNull()
    expect(document.querySelector('.board-lane-add')).not.toBeNull()
  })

  // reason: a bug lane is a campaign's overflow and not a unit of work someone
  // puts down, so it does not fold — its title stays a plain span rather than a
  // button, and there is nothing to press it shut with.
  it('leaves a bug lane unfoldable', async () => {
    await load(bridge(oneMission({ campaignBug: true })))
    const bugTitle = [...document.querySelectorAll('.board-lane-title')].find((node) => node.textContent === 'Bugs')
    expect(bugTitle?.tagName).toBe('SPAN')
  })

  // reason: the fold is keyed by folder path, so folding one campaign is not
  // folding a flag every campaign shares — the next group is left as it was.
  it('folds one campaign without folding another', async () => {
    await load(bridge(twoCampaigns()))
    const folds = document.querySelectorAll<HTMLElement>('.board-group-fold')
    expect(folds.length).toBe(2)
    folds[0].click()
    const groups = document.querySelectorAll('.board-group')
    expect(groups[0].querySelector('.board-lane')).toBeNull()
    expect(groups[1].querySelector('.board-lane')).not.toBeNull()
  })

  // reason: every write an agent makes re-reads the board and rebuilds the DOM,
  // so a fold written into the DOM would spring open on the next `tasks:changed`
  // — it lives in module state precisely so it does not.
  it('keeps a fold across a tasks:changed redraw', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-group-fold')?.click()
    expect(document.querySelector('.board-lane')).toBeNull()
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-lane')).toBeNull()
  })

  // reason: a fold is keyed by folder path and a path is another project's work
  // in the next repository — a campaign left folded across the change would be
  // this state describing a board it was never about.
  it('clears folds when the project changes', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-group-fold')?.click()
    expect(document.querySelector('.board-lane')).toBeNull()
    stub.readTasks = async () => oneMission({ project: '/p/other' })
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-lane')).not.toBeNull()
  })

  // reason: the spec says a reveal unfolds whatever it has to. A card in a
  // folded mission under a folded campaign is a target nothing could see, so
  // both are opened before the mark is drawn.
  it('unfolds the campaign and mission a reveal lands inside', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-lane .board-lane-title')?.click()
    document.querySelector<HTMLElement>('.board-group-fold')?.click()
    expect(document.querySelector('.board-lane')).toBeNull()
    stub.reveal('campaigns/q3/missions/m1/tasks/t1')
    expect(document.querySelector('.board-column')).not.toBeNull()
    expect(document.querySelector('.board-card-revealed')?.textContent).toContain('T1')
  })
})

/**
 * The detail, as the panel puts it in place of the columns.
 *
 * What `board-detail.spec.ts` does not cover: that surface is a pure function
 * from data to DOM, and these are about which surface is on screen and what
 * the panel re-reads while one is.
 */
describe('a detail in the panel', () => {
  /**
   * Open the first card's detail and settle.
   *
   * Takes nothing: the click goes through the document, and the bridge the
   * detail then reads through is the one `load` already installed.
   * @returns resolution once the detail has been drawn.
   */
  async function openFirstCard(): Promise<void> {
    document.querySelector<HTMLElement>('.board-card')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }

  it('draws the detail in place of the columns', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    await openFirstCard()
    expect(document.querySelector('.board-detail-title')?.textContent).toBe('T1')
    expect(document.querySelector('.board-column')).toBeNull()
  })

  // reason: the detail replaces the board, so back is the only way the board
  // comes back — and the spec is explicit that this is not a modal.
  it('puts the columns back when back is pressed', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    await openFirstCard()
    document.querySelector<HTMLElement>('.board-detail-back')?.click()
    expect(document.querySelector('.board-detail')).toBeNull()
    expect(document.querySelector('.board-column')).not.toBeNull()
  })

  // reason: every redraw rebuilds the container, and a `tasks:changed` from an
  // agent's own write arrives while somebody is reading a detail. A redraw
  // that put the columns back would throw them out of what they were reading.
  it('redraws the detail, not the board, when the board changes underneath', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    await openFirstCard()
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-detail-title')).not.toBeNull()
    expect(document.querySelector('.board-column')).toBeNull()
    // Re-read rather than redrawn from the copy it was opened with: an
    // agent's edit has to reach the surface that is showing.
    expect(stub.calls.filter((call) => call[0] === 'detail').length).toBe(2)
  })

  // reason: the re-read is one await long, and a back press landing inside it
  // was overwritten by the answer that arrived afterwards — the reader pressed
  // back, saw the columns, and the detail they had just left came back on its
  // own. The redraw a `tasks:changed` triggers is about the surface that was
  // open when it started, and it no longer is.
  it('does not put a closed detail back when a re-read lands after back', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    await openFirstCard()
    let answer: ((value: Record<string, unknown>) => void) | undefined
    stub.readTaskDetail = async () =>
      await new Promise<Record<string, unknown>>((resolve) => {
        answer = resolve
      })
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    // Inside the window: the board has been re-read, the entity has not.
    document.querySelector<HTMLElement>('.board-detail-back')?.click()
    expect(document.querySelector('.board-column')).not.toBeNull()
    answer?.({ ...detail(), folderPath: 'campaigns/q3/missions/m1/tasks/t1' })
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-detail')).toBeNull()
    expect(document.querySelector('.board-column')).not.toBeNull()
  })

  // reason: `openDetail` has the same await and the same unconditional
  // assignment. A reveal landing inside it names the columns and a mark on
  // them, and the detail arriving afterwards would take both away.
  it('does not open a detail whose read lands after the tree reveals a card', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    let answer: ((value: Record<string, unknown>) => void) | undefined
    stub.readTaskDetail = async () =>
      await new Promise<Record<string, unknown>>((resolve) => {
        answer = resolve
      })
    document.querySelector<HTMLElement>('.board-card')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    stub.reveal('campaigns/q3/missions/m1')
    answer?.({ ...detail(), folderPath: 'campaigns/q3/missions/m1/tasks/t1' })
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-detail')).toBeNull()
    expect(document.querySelector('.board-lane-revealed')).not.toBeNull()
  })

  // reason: an entity an agent deleted while its detail was open leaves the
  // panel drawing something that is not there. The board is what is left.
  it('falls back to the columns, with a note, when the entity is gone', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    await openFirstCard()
    stub.readTaskDetail = async () => undefined
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-detail')).toBeNull()
    expect(document.querySelector('.board-column')).not.toBeNull()
    expect(document.getElementById('board-note')?.textContent).toContain('no longer on the board')
  })

  // reason: a reveal names a card, a lane or a heading, and all three are on
  // the columns — one marked behind an open detail would be a highlight
  // nobody can see, which is the thing the reveal exists to end.
  it('lands on the board when the tree reveals something', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    await openFirstCard()
    stub.reveal('campaigns/q3/missions/m1')
    expect(document.querySelector('.board-detail')).toBeNull()
    expect(document.querySelector('.board-lane-revealed')).not.toBeNull()
  })

  // reason: a folder path names different work in a different repository, so
  // a detail carried across would be one project's entity over another's.
  it('closes when the project changes', async () => {
    const stub = bridge(oneMission(), { detail: detail() })
    await load(stub)
    await openFirstCard()
    stub.readTasks = async () => oneMission({ project: '/p/other' })
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-detail')).toBeNull()
    expect(document.querySelector('.board-column')).not.toBeNull()
  })

  // reason: the two writes the detail owns are the board's own, and they go
  // through the same bridge the drag does — a detail that wrote through some
  // second path could disagree with the card about what happened.
  it('writes a status and a tick through the board’s own bridge', async () => {
    const stub = bridge(oneMission(), {
      // The checkboxes go where the section says, and a task's document owns
      // that section — a level whose document does not is the finding
      // `board-detail.spec.ts` covers, not a case for this one.
      detail: detail({
        sections: [{ heading: 'Acceptance Criteria', body: '- [ ] It holds' }],
        criteria: [{ text: 'It holds', done: false }],
      }),
    })
    await load(stub)
    await openFirstCard()
    const select = document.querySelector<HTMLSelectElement>('.board-detail-select')
    if (select !== null) select.value = 'done'
    select?.dispatchEvent(new Event('change'))
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    // Queried again: the write above redrew the surface, so the checkbox from
    // before it is no longer the one on screen. Checked first, because that is
    // what a pointer does before the browser fires `change` — a bare event on
    // an unticked box asks for an untick, which is the one value that would
    // also come back from a handler that read nothing.
    const box = document.querySelector<HTMLInputElement>('.board-detail-tick')
    if (box !== null) box.checked = true
    box?.dispatchEvent(new Event('change'))
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(stub.calls).toContainEqual(['status', 'campaigns/q3/missions/m1/tasks/t1', 'done'])
    expect(stub.calls).toContainEqual(['tick', 'campaigns/q3/missions/m1/tasks/t1', 0, true])
  })

  // reason: a detail's prose is markdown an agent wrote, inserted into the
  // page that holds the preload. The pure surface decides that an http link
  // is not followed; this is the half that decides where it goes instead, and
  // the two only meet here.
  it('opens a link in a detail through the browser rather than in the pane', async () => {
    const stub = bridge(oneMission(), {
      detail: detail({ sections: [{ heading: 'Notes', body: '[the RFC](https://example.com/rfc)' }] }),
    })
    await load(stub)
    await openFirstCard()
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.querySelector<HTMLElement>('.board-detail-prose a')?.dispatchEvent(click)
    expect(stub.calls).toContainEqual(['external', 'https://example.com/rfc'])
    expect(click.defaultPrevented).toBe(true)
  })

  // reason: Open file is the detour into the editor, and the file comes from
  // the read rather than from the level — an unconverted board still holds a
  // `.yaml`, and the level alone cannot say which is there.
  it('hands the editor the file the read named', async () => {
    const stub = bridge(oneMission(), { detail: detail({ file: 'workitem.yaml' }) })
    await load(stub)
    await openFirstCard()
    document.querySelector<HTMLElement>('.board-detail-file')?.click()
    expect(stub.calls).toContainEqual(['open', 'campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml'])
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

  // reason: the backdrop is the modal's whole claim to being modal — it takes
  // the pointer events so a lane's plus, visible through it, cannot be
  // pressed while a name is half typed. jsdom does no CSS hit-testing, so the
  // obvious assertion — that the click never reaches the control behind — is
  // not available here: what is asserted instead is the half this page owns,
  // that a click landing on the backdrop goes no further than the modal.
  it('swallows a click on its backdrop rather than letting it through', async () => {
    await load(bridge(oneMission()))
    document.querySelector<HTMLElement>('.board-lane-add')?.click()
    let escaped = false
    document.body.addEventListener('click', () => {
      escaped = true
    })
    document.getElementById('board-modal')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(escaped).toBe(false)
  })

  // reason: the test above only proves this page's own listener does not let a
  // backdrop click through — it says nothing about whether the backdrop can be
  // clicked at all. That is decided by CSS, not JS: `pointer-events: none` on
  // an overlay means click-through (the element stops being a hit-test
  // target, so the click lands on whatever is behind it), which reads as the
  // opposite of what the property name suggests — an easy mistake to make
  // twice, and this repo already made it once (see `pane.css`'s comment on
  // this rule). jsdom does no CSS hit-testing, so no jsdom test can see
  // `pointer-events` at all; this test reads the stylesheet itself instead.
  it('keeps the backdrop as a hit-test target (pointer-events is not none)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(import.meta.dirname, '..', 'pane.css'), 'utf8')
    const match = css.match(/\.board-modal\s*\{([^}]*)\}/)
    expect(match).not.toBeNull()
    expect(match?.[1]).not.toMatch(/pointer-events\s*:\s*none/)
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

/**
 * The Tests destination: the third thing the panel can put in its container.
 *
 * A test has no status and so no column, which until now meant the board had
 * no way to show one at all — these are about the way in that does not
 * require already knowing the test is there.
 */
describe('the Tests destination', () => {
  /**
   * A board whose suite tree has one sub-suite with one test in it.
   * @param over - what this case is about, passed through to `oneMission`.
   * @returns the board, as `readTasks` answers it.
   */
  function withTests(over: Parameters<typeof oneMission>[0] = {}): Record<string, unknown> {
    return {
      ...oneMission(over),
      tests: {
        path: 'tests',
        slug: 'tests',
        suites: [
          {
            path: 'tests/auth',
            slug: 'auth',
            suites: [],
            tests: [{ folderPath: 'tests/auth/login', name: 'Login holds', validates: { pass: 1, total: 2 } }],
          },
        ],
        tests: [],
      },
    }
  }

  // reason: this is the second half of the complaint the change is about —
  // a test was reachable only by knowing it existed, and the board's whole
  // job is to show what is there.
  it('draws the suite tree from the header’s Tests control', async () => {
    await load(bridge(withTests()))
    document.getElementById('board-tests')?.click()
    expect([...document.querySelectorAll('.board-tests-suite')].map((node) => node.textContent)).toEqual(['auth'])
    const row = document.querySelector('.board-tests-row')
    expect(row?.textContent).toContain('Login holds')
    // The reverse of a card's dot: what the test proves, and how much holds —
    // drawn the same way, a coloured dot plus a neutral count, not the old
    // text chip.
    const dot = row?.querySelector('.verdict-dot')
    expect(dot).not.toBeNull()
    expect(dot?.classList.contains('verdict-dot-fail')).toBe(true)
    expect(row?.querySelector('.board-card-verdict-count')?.textContent).toBe('1/2')
    // It is a destination, not an overlay: the columns are gone while it is up.
    expect(document.querySelector('.board-column')).toBeNull()
  })

  // reason: a row that only listed tests would be a dead end — the detail is
  // the surface everything else on this board opens into, tests included.
  it('opens a test’s detail from a row', async () => {
    const stub = bridge(withTests(), { detail: detail({ level: 'test', status: '', name: 'Login holds' }) })
    await load(stub)
    document.getElementById('board-tests')?.click()
    document.querySelector<HTMLElement>('.board-tests-row')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(stub.calls).toContainEqual(['detail', 'tests/auth/login'])
    expect(document.querySelector('.board-detail-title')?.textContent).toBe('Login holds')
  })

  // reason: back walks out the way it came in. A test opened from Tests
  // returns to Tests, and only the second back reaches the columns — a
  // detail that dropped the reader on the board would undo the navigation
  // rather than reverse it.
  it('walks back out through Tests, then to the columns', async () => {
    const stub = bridge(withTests(), { detail: detail({ level: 'test', status: '' }) })
    await load(stub)
    document.getElementById('board-tests')?.click()
    document.querySelector<HTMLElement>('.board-tests-row')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    document.querySelector<HTMLElement>('.board-detail-back')?.click()
    expect(document.querySelector('.board-tests-row')).not.toBeNull()
    // The surfaces are exclusive, so the back inside the Tests destination is
    // the destination's own — it needs no class of its own to be told apart.
    document.querySelector<HTMLElement>('.board-tests .board-detail-back')?.click()
    expect(document.querySelector('.board-column')).not.toBeNull()
  })

  // reason: found by opening the running app — the control said one place and
  // went to another. A detail opened over the Tests list goes back to Tests,
  // so a label reading "Board" is the surface lying about where it is about to
  // put you, and the label could not be fixed inside `board-detail.ts`: back
  // was a bare callback and the destination lives only in `board.ts`.
  it('labels back with the surface it returns to, on each of the two', async () => {
    const stub = bridge(withTests(), { detail: detail({ level: 'test', status: '' }) })
    await load(stub)
    document.getElementById('board-tests')?.click()
    document.querySelector<HTMLElement>('.board-tests-row')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-detail-back')?.textContent).toBe('← Tests')
    document.querySelector<HTMLElement>('.board-detail-back')?.click()
    // The Tests list's own back is the same control drawn from the same
    // source, so it cannot drift from the detail's.
    expect(document.querySelector('.board-tests .board-detail-back')?.textContent).toBe('← Board')
    document.querySelector<HTMLElement>('.board-tests .board-detail-back')?.click()
    document.querySelector<HTMLElement>('.board-card')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-detail-back')?.textContent).toBe('← Board')
  })

  // reason: the tree's test row names a folder the board draws no card for.
  // Marking the columns would point at nothing; the detail is what a test
  // row goes to, and the board is the surface that knows which paths are
  // tests.
  it('opens the detail when the tree names a test', async () => {
    const stub = bridge(withTests(), { detail: detail({ level: 'test', status: '', name: 'Login holds' }) })
    await load(stub)
    stub.reveal('tests/auth/login')
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(stub.calls).toContainEqual(['detail', 'tests/auth/login'])
    expect(document.querySelector('.board-detail-title')?.textContent).toBe('Login holds')
    expect(document.querySelector('.board-card-revealed')).toBeNull()
  })

  // reason: a control that vanished with the last test would make the
  // destination something you have to already know about, which is the thing
  // it exists to fix — so it stays, and the destination words its own empty.
  it('keeps the control on a board with no tests, and words the empty', async () => {
    await load(bridge(oneMission()))
    expect(document.getElementById('board-head')?.hidden).toBe(false)
    document.getElementById('board-tests')?.click()
    expect(document.querySelector('.board-tests')?.textContent).toContain('No tests yet')
  })

  // reason: the header is the columns' own chrome. Left up behind either
  // destination it would offer a second way out beside the one that surface
  // already carries — and it has to come back when the columns do, or the
  // Tests control is a door that closes behind you.
  it('hides the header while a destination is open', async () => {
    const stub = bridge(withTests(), { detail: detail() })
    await load(stub)
    document.getElementById('board-tests')?.click()
    expect(document.getElementById('board-head')?.hidden).toBe(true)
    document.querySelector<HTMLElement>('.board-tests .board-detail-back')?.click()
    expect(document.getElementById('board-head')?.hidden).toBe(false)
    document.querySelector<HTMLElement>('.board-card')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.getElementById('board-head')?.hidden).toBe(true)
  })

  // reason: a reveal names a card, a lane or a heading, and all three are on
  // the columns. Left on the Tests list there is nothing for the mark to land
  // on and nothing to scroll, and the tab is brought forward on the surface
  // the reader was already looking at — a click that reads as doing nothing.
  it('leaves the destination when the tree reveals a card', async () => {
    const stub = bridge(withTests())
    await load(stub)
    document.getElementById('board-tests')?.click()
    stub.reveal('campaigns/q3/missions/m1/tasks/t1')
    expect(document.querySelector('.board-tests')).toBeNull()
    expect(document.querySelector('.board-card-revealed')?.textContent).toContain('T1')
  })

  // reason: the mark says what the tree has selected now. A test named after
  // a card is a new selection, so the card's highlight is the previous one —
  // and backing out of the test's detail is where it would be seen, on a
  // board marking a row nothing points at any more.
  it('drops the previous mark when the tree names a test', async () => {
    const stub = bridge(withTests(), { detail: detail({ level: 'test', status: '' }) })
    await load(stub)
    stub.reveal('campaigns/q3/missions/m1/tasks/t1')
    expect(document.querySelector('.board-card-revealed')).not.toBeNull()
    stub.reveal('tests/auth/login')
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    document.querySelector<HTMLElement>('.board-detail-back')?.click()
    expect(document.querySelector('.board-column')).not.toBeNull()
    expect(document.querySelector('.board-card-revealed')).toBeNull()
  })

  // reason: this destination names something every board has rather than a
  // path, so unlike the detail and the highlight it means the same thing in
  // the next repository — closing it on a project change would be the panel
  // deciding the reader is done here.
  it('stays open when the project changes', async () => {
    const stub = bridge(withTests())
    await load(stub)
    document.getElementById('board-tests')?.click()
    stub.readTasks = async () => withTests({ project: '/p/other' })
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-tests-row')).not.toBeNull()
    expect(document.querySelector('.board-column')).toBeNull()
  })

  // reason: the same rule the tree applies to the same tree — a heading with
  // nothing under it is a section the reader has to open to find out it is
  // empty, and nesting is where that is easiest to get wrong.
  it('drops a suite with no test anywhere beneath it', async () => {
    const board = withTests()
    ;(board.tests as { suites: unknown[] }).suites.push({
      path: 'tests/spare',
      slug: 'spare',
      suites: [{ path: 'tests/spare/deeper', slug: 'deeper', suites: [], tests: [] }],
      tests: [],
    })
    await load(bridge(board))
    document.getElementById('board-tests')?.click()
    expect([...document.querySelectorAll('.board-tests-suite')].map((node) => node.textContent)).toEqual(['auth'])
  })
})

// The design pass lives in `pane.css`, and jsdom lays nothing out, so — as the
// backdrop's `pointer-events` and the card name's `overflow-wrap` already are —
// these rules are read from the stylesheet itself rather than measured. What is
// pinned here is what the plan's Design Lock makes non-negotiable: no phantom
// token silently falling back to `currentColor`, the glyph and dot coloured
// from the right token, the card no longer a boxed container, and the detail
// capped at a readable measure.
describe('the board stylesheet', () => {
  async function css(): Promise<string> {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    return readFileSync(join(import.meta.dirname, '..', 'pane.css'), 'utf8')
  }

  function rule(text: string, selector: string): string {
    // The literal selector, then its brace block. Selectors here have no regex
    // metacharacters but the dots, which must match a dot and not any char.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = text.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
    expect(match, `no rule for ${selector}`).not.toBeNull()
    return match?.[1] ?? ''
  }

  // reason: none of these three tokens exist in the app's token set, so every
  // reference silently took its `, currentColor` / `, transparent` fallback —
  // a colour nobody chose. The Design Lock calls them phantom and says to
  // replace every one; the whole file must be clean of them.
  it('references no phantom token', async () => {
    const text = await css()
    expect(text).not.toContain('--dsw-alias-interactive-primary')
    expect(text).not.toContain('--dsw-alias-border-primary')
    expect(text).not.toContain('--dsw-alias-surface-primary')
  })

  // reason: a board card is a raised surface on a receded tray, not a
  // borderless row. A borderless card had the tray's own colour and vanished
  // into it on screen; the anti-slop rule bars a card used only to group
  // things, but this one is the object you drag between columns — an
  // interaction container — so it earns a surface (`bg-layer-2`) and a border
  // to stand apart from the dark canvas.
  it('gives the card a raised surface, not the tray colour', async () => {
    const card = rule(await css(), '.board-card')
    expect(card).toMatch(/background\s*:\s*var\(--dsw-alias-bg-layer-2\)/)
    expect(card).toMatch(/border\s*:\s*1px solid var\(--dsw-alias-border-l2\)/)
  })

  // reason: the tray carries no fill of its own — a filled tray is what made
  // the cards the same colour as the space between columns. The columns are
  // told apart by their cards and labels on the dark canvas, not by five grey
  // blocks, so `.board-column` must not paint a background.
  it('lets the column tray recede to the canvas', async () => {
    expect(rule(await css(), '.board-column')).toMatch(/background\s*:\s*transparent/)
  })

  // reason: colour enters the glyph only through the token its class sets —
  // done proven green, executing live in the app's own accent — and never as a
  // literal or a `currentColor` fallback.
  it('colours the status glyph from its state token', async () => {
    const text = await css()
    expect(rule(text, '.status-glyph-done')).toMatch(
      /color\s*:\s*var\(--dsw-alias-state-success-primary\)/,
    )
    expect(rule(text, '.status-glyph-executing')).toMatch(
      /color\s*:\s*var\(--dsw-alias-state-business-primary\)/,
    )
  })

  // reason: the reveal ring is the app's accent, and the phantom
  // `--dsw-alias-interactive-primary` it used to name fell back to
  // `currentColor` — the card's own text colour, not an accent at all.
  it('draws the reveal ring in the accent token', async () => {
    expect(rule(await css(), '.board-card-revealed')).toMatch(
      /var\(--dsw-alias-state-business-primary\)/,
    )
  })

  // reason: the detail is prose on the bare canvas, so it is capped at a
  // readable measure rather than run to the panel's width.
  it('caps the detail prose at a measure', async () => {
    expect(rule(await css(), '.board-detail-prose')).toMatch(/max-width\s*:/)
  })
})
