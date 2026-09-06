// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The tree's markup, cut to what it writes into. */
function page(): void {
  document.body.innerHTML =
    '<p class="empty" id="tasks-empty" hidden></p>' +
    '<p class="git-note" id="tasks-note" hidden></p><div id="tasks-tree"></div>'
}

/** A board for the stub bridge, with only what a case names. */
function board(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { project: '/p/one', present: true, campaigns: [], tests: { path: 'tests', slug: 'tests', suites: [], tests: [] }, findings: [], ...over }
}

/** One entity for a stub board. */
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

interface Stub {
  readTasks: () => Promise<unknown>
  onTasksChanged: (listener: () => void) => void
  revealOnBoard: (folderPath: string) => void
  askTheme: () => void
  onTheme: () => void
  calls: unknown[][]
  fire: () => void
}

/**
 * A bridge answering with one board and recording what the tree asks for.
 * @param data - what `readTasks` answers.
 * @returns the bridge.
 */
function bridge(data: Record<string, unknown>): Stub {
  const calls: unknown[][] = []
  let changed: (() => void) | undefined
  return {
    calls,
    readTasks: async () => data,
    onTasksChanged: (listener) => {
      changed = listener
    },
    fire: () => changed?.(),
    revealOnBoard: (folderPath) => calls.push(['reveal', folderPath]),
    askTheme: () => {},
    onTheme: () => {},
  }
}

/**
 * Load the tree against a stub bridge.
 * @param stub - the bridge.
 * @returns resolution once the first read has been drawn.
 */
async function load(stub: Stub): Promise<void> {
  ;(globalThis as unknown as { pane: unknown }).pane = stub
  vi.resetModules()
  await import('./tasks-tree.ts')
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

beforeEach(page)

describe('the tasks tree', () => {
  it('words a project with no board rather than drawing an empty tree', async () => {
    await load(bridge(board({ present: false })))
    expect(document.getElementById('tasks-empty')?.hidden).toBe(false)
    expect(document.getElementById('tasks-empty')?.textContent).toContain('no board')
  })

  // reason: with no project open there is no place to create a campaign in,
  // so the advice that names one would be pointing at nothing.
  it('words no project apart from a project with no board', async () => {
    await load(bridge(board({ project: undefined, present: false })))
    expect(document.getElementById('tasks-empty')?.textContent).toContain('No project is open')
  })

  it('nests a campaign, its mission and its task', async () => {
    await load(
      bridge(
        board({
          campaigns: [
            node('campaign', 'Q3', 'campaigns/q3', {
              children: [
                node('mission', 'M1', 'campaigns/q3/missions/m1', {
                  children: [node('task', 'T1', 'campaigns/q3/missions/m1/tasks/t1')],
                }),
              ],
            }),
          ],
        }),
      ),
    )
    const names = [...document.querySelectorAll('.tree-name')].map((node) => node.textContent)
    expect(names).toEqual(['Q3', 'M1', 'T1'])
  })

  // reason: a campaign's progress is computed on read and shown; nothing
  // writes it, and it is what tells you a lane is nearly done at a glance.
  it('shows progress on a container and a status on everything', async () => {
    await load(
      bridge(
        board({
          campaigns: [node('campaign', 'Q3', 'campaigns/q3', { status: 'executing', progress: { done: 1, total: 3 } })],
        }),
      ),
    )
    expect(document.getElementById('tasks-tree')?.textContent).toContain('1/3')
    expect(document.getElementById('tasks-tree')?.textContent).toContain('executing')
  })

  it('draws the tests root with its suites and tests', async () => {
    await load(
      bridge(
        board({
          tests: {
            path: 'tests',
            slug: 'tests',
            suites: [{ path: 'tests/auth', slug: 'auth', suites: [], tests: [{ folderPath: 'tests/auth/login', name: 'Login', validates: { pass: 1, total: 2 } }] }],
            tests: [],
          },
        }),
      ),
    )
    const text = document.getElementById('tasks-tree')?.textContent ?? ''
    expect(text).toContain('auth')
    expect(text).toContain('Login')
    // reason: the reverse direction — what a test proves — is visible nowhere
    // else, so the tree is the only place it can be read.
    expect(text).toContain('1/2')
  })

  // reason: `test.yaml` was the answer to "what is this test" for the same
  // reason `workitem.yaml` was the answer for a task, and it was the same
  // wrong answer: a serialised map. The board draws no card for a test, so
  // this is not a highlight — the panel reads the name it is handed and puts
  // the test's own detail up, which is where a card's click goes too.
  it('sends a test to the board, which opens its detail rather than a file', async () => {
    const stub = bridge(
      board({
        tests: {
          path: 'tests',
          slug: 'tests',
          suites: [],
          tests: [{ folderPath: 'tests/login', name: 'Login', validates: { pass: 1, total: 1 } }],
        },
      }),
    )
    await load(stub)
    const rows = [...document.querySelectorAll<HTMLElement>('.tree-row')]
    rows[rows.length - 1].click()
    expect(stub.calls).toEqual([['reveal', 'tests/login']])
  })

  // reason: a fold is keyed on a board-relative path, and `campaigns/q3` is a
  // path two projects can both have — a row folded in one would open the next
  // project already folded, describing a board it was never about.
  it('forgets what was folded when the project changes', async () => {
    const shape = (project: string): Record<string, unknown> =>
      board({
        project,
        campaigns: [
          node('campaign', 'Q3', 'campaigns/q3', {
            children: [node('mission', 'M1', 'campaigns/q3/missions/m1')],
          }),
        ],
      })
    const stub = bridge(shape('/p/one'))
    await load(stub)
    document.querySelector<HTMLElement>('.tree-twisty')?.click()
    expect([...document.querySelectorAll('.tree-name')].map((node) => node.textContent)).toEqual(['Q3'])
    stub.readTasks = async () => shape('/p/other')
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect([...document.querySelectorAll('.tree-name')].map((node) => node.textContent)).toEqual(['Q3', 'M1'])
  })

  it('asks main to reveal a row on the board when it is clicked', async () => {
    const stub = bridge(
      board({ campaigns: [node('campaign', 'Q3', 'campaigns/q3')] }),
    )
    await load(stub)
    document.querySelector<HTMLElement>('.tree-row')?.click()
    expect(stub.calls).toContainEqual(['reveal', 'campaigns/q3'])
  })

  // reason: the tree navigates and changes nothing. A row that wrote would
  // make the two views disagree about who owns a status.
  it('never writes anything', async () => {
    const stub = bridge(board({ campaigns: [node('campaign', 'Q3', 'campaigns/q3')] }))
    await load(stub)
    document.querySelector<HTMLElement>('.tree-row')?.click()
    expect(stub.calls.every((call) => call[0] === 'reveal')).toBe(true)
  })

  it('says how many files the board could not read', async () => {
    await load(bridge(board({ findings: [{ folderPath: 'campaigns/q3', says: 'bad' }] })))
    const note = document.getElementById('tasks-note')
    expect(note?.hidden).toBe(false)
    expect(note?.textContent).toContain('1')
  })

  it('re-reads when main says the board moved', async () => {
    const stub = bridge(board({ campaigns: [node('campaign', 'Q3', 'campaigns/q3')] }))
    let reads = 0
    stub.readTasks = async () => {
      reads += 1
      return board({ campaigns: [node('campaign', 'Q3', 'campaigns/q3')] })
    }
    await load(stub)
    expect(reads).toBe(1)
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(reads).toBe(2)
  })
})
