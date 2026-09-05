# Task Board: The Two Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the board visible and workable — a tree of the hierarchy in the side column, and a swimlane board in the content panel where a card is dragged between status columns.

**Architecture:** The tree is a third `SideView` beside `files` and `git`: its own rail button, its own page, its own `WebContentsView`, exactly as the git panel was added. The board is a third `PaneTab` beside `editor` and `web`: a panel inside `pane.html`, drawn by the pane's own bundle. They are different documents, so everything between them crosses main — the tree's row click reaches the board, and a card's click reaches the editor, the way a git row already reaches the diff. Both call one read channel and listen for one change event, so they cannot disagree about what is on the board.

**Tech Stack:** TypeScript, Electron `WebContentsView`, esbuild bundles, Vitest with jsdom for the renderer halves.

**Spec:** `docs/notes/task-board-views.md`, which argues from `docs/notes/task-board.md`.

## Global Constraints

- **No formatter is configured.** Do NOT run `prettier`, `eslint --fix`, or any other formatter. Match the surrounding style by hand: 2-space indent, **no semicolons**, **single quotes**, ~120-column lines.
- **Stage only the files your task names.** Never `git add -A`, `git add .`, or `git commit -a`. The repo root holds untracked `index.js` and `tree-menu.js` belonging to the user, which must never be committed.
- **Every exported symbol carries a JSDoc block** with `@param` and `@returns`, saying *why*, not *what*, in the voice of the surrounding code.
- **The store is finished and is not to be changed.** `src/main/board/` is complete, reviewed and tested. These views read and call it; they do not extend it. If a view seems to need a new store function, stop and report rather than adding one.
- **Nothing infers a status.** A status changes only because someone dragged a card or an agent set it. `progress` and the validation chip are computed on read and shown; nothing writes them.
- **A test is never a card.** Tests have no status, so there is no column they belong in. They appear as a validation chip on the workitem that names them, and as rows in the tree.
- **Drag writes on drop, never on hover.** A card that changed status while dragged over a column would write a status nobody chose.
- **A failed write puts the card back** in the column it came from, and says why.
- **The create modal closes on Cancel and on its close control, and on nothing else** — not a backdrop click, not Escape. Both controls are focusable so a keyboard user is never trapped.
- Statuses, in board order: `draft`, `executing`, `awaitingApproval`, `done`, `failed`, `cancelled`.
- Commands: `npm test`, `npx vitest run <file>`, `npx tsc -p tsconfig.json --noEmit` (main), `npx tsc -p tsconfig.pane.json --noEmit` (renderer/pane). Both typechecks clean before every commit.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/main/board-ipc.ts` | The read channel, the four write channels, and the watcher. Everything main does for these views. |
| `src/renderer/tasks.html` | The tree's page. |
| `src/renderer/pane/tasks-tree.ts` | The tree's renderer. |
| `src/renderer/pane/board-rows.ts` | Pure: a `Board` into campaigns, lanes and columns. Shared by both views. |
| `src/renderer/pane/board.ts` | The swimlane board panel, its drag, and its modal. |

**Modified:** `src/main/layout.ts`, `src/main/window.ts`, `src/main/index.ts`, `src/preload/pane.ts`, `src/preload/shell.ts`, `src/renderer/shell.html`, `src/renderer/shell.js`, `src/renderer/pane.html`, `src/renderer/pane/tabs.ts`, `src/renderer/pane/main.ts`, `src/renderer/pane.css`, `package.json`.

---

### Task 1: Grouping a board into lanes and columns

The pure half, first and alone, because both views draw from it and it is where the bugs are. No DOM, no Electron.

**Files:**
- Create: `src/renderer/pane/board-rows.ts`
- Test: `src/renderer/pane/board-rows.spec.ts`

**Interfaces:**
- Consumes: nothing. It defines its own view types rather than importing main's, the way `git-rows.ts` already does — the renderer must not import from `src/main/`.
- Produces:
  ```ts
  export const BOARD_STATUSES: readonly string[]
  export interface EntityView {
    level: string
    folderPath: string
    name: string
    status: string
    children: EntityView[]
    progress: { done: number; total: number }
    criteria: { done: number; total: number }
    verdicts: { pass: number; total: number }
  }
  export interface LaneView { key: string; title: string; folderPath: string; status: string; kind: 'mission' | 'campaign-bugs'; columns: Record<string, EntityView[]> }
  export interface GroupView { campaign: EntityView; lanes: LaneView[] }
  export function groupBoard(campaigns: EntityView[]): GroupView[]
  export function chipOf(entity: EntityView): { text: string; failing: boolean } | undefined
  ```

- [ ] **Step 1: Write the failing test**

Create `src/renderer/pane/board-rows.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BOARD_STATUSES, chipOf, groupBoard, type EntityView } from './board-rows.ts'

/**
 * One entity for the grouper, with only the fields a case names.
 * @param over - what this entity is.
 * @returns the entity.
 */
function entity(over: Partial<EntityView> & { level: string; name: string }): EntityView {
  return {
    folderPath: `campaigns/${over.name}`,
    status: 'draft',
    children: [],
    progress: { done: 0, total: 0 },
    criteria: { done: 0, total: 0 },
    verdicts: { pass: 0, total: 0 },
    ...over,
  }
}

describe('BOARD_STATUSES', () => {
  // reason: these are the columns, in the order they are drawn. An empty one
  // is information — it names a place work can go — so the set never changes
  // shape with the data.
  it('is the six statuses in board order', () => {
    expect([...BOARD_STATUSES]).toEqual(['draft', 'executing', 'awaitingApproval', 'done', 'failed', 'cancelled'])
  })
})

describe('groupBoard', () => {
  it('gives each campaign a group and each mission a lane', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'mission', name: 'M1', folderPath: 'campaigns/q3/missions/m1' })],
      }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].campaign.name).toBe('Q3')
    expect(groups[0].lanes.map((lane) => lane.title)).toEqual(['M1'])
  })

  // reason: a lane waiting to be filled, not a mission that has gone missing.
  it('gives a mission with no work a lane anyway', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Q3', children: [entity({ level: 'mission', name: 'M1' })] }),
    ])
    expect(groups[0].lanes).toHaveLength(1)
    for (const status of BOARD_STATUSES) expect(groups[0].lanes[0].columns[status]).toEqual([])
  })

  it('puts a mission’s tasks and bugs in the columns their statuses name', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [
          entity({
            level: 'mission',
            name: 'M1',
            children: [
              entity({ level: 'task', name: 'T1', status: 'done' }),
              entity({ level: 'bug', name: 'B1', status: 'executing' }),
            ],
          }),
        ],
      }),
    ])
    const lane = groups[0].lanes[0]
    expect(lane.columns.done.map((card) => card.name)).toEqual(['T1'])
    expect(lane.columns.executing.map((card) => card.name)).toEqual(['B1'])
    expect(lane.columns.draft).toEqual([])
  })

  // reason: a bug filed against a campaign has no mission to sit in, and a
  // bug that appeared nowhere would be a defect the board had lost.
  it('gives a campaign’s own bugs a lane of their own', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'bug', name: 'Crash', status: 'failed' })],
      }),
    ])
    expect(groups[0].lanes).toHaveLength(1)
    expect(groups[0].lanes[0].kind).toBe('campaign-bugs')
    expect(groups[0].lanes[0].columns.failed.map((card) => card.name)).toEqual(['Crash'])
  })

  it('gives no bug lane to a campaign that has none', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Q3', children: [entity({ level: 'mission', name: 'M1' })] }),
    ])
    expect(groups[0].lanes.every((lane) => lane.kind === 'mission')).toBe(true)
  })

  // reason: a status the board does not draw would drop the card silently.
  // It goes in the first column, where it is visible and can be dragged out.
  it('puts a card with an unknown status in the first column', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'mission', name: 'M1', children: [entity({ level: 'task', name: 'T1', status: 'weird' })] })],
      }),
    ])
    expect(groups[0].lanes[0].columns.draft.map((card) => card.name)).toEqual(['T1'])
  })

  // reason: a test has no status, so there is no column it belongs in — and
  // one placed in a column would read as work in flight, which it is not.
  it('never makes a card of a test', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'mission', name: 'M1', children: [entity({ level: 'test', name: 'Login', status: '' })] })],
      }),
    ])
    for (const status of BOARD_STATUSES) expect(groups[0].lanes[0].columns[status]).toEqual([])
  })

  it('gives every lane a key unique across the board', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'A', folderPath: 'campaigns/a', children: [entity({ level: 'mission', name: 'M', folderPath: 'campaigns/a/missions/m' })] }),
      entity({ level: 'campaign', name: 'B', folderPath: 'campaigns/b', children: [entity({ level: 'mission', name: 'M', folderPath: 'campaigns/b/missions/m' })] }),
    ])
    const keys = groups.flatMap((group) => group.lanes.map((lane) => lane.key))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('chipOf', () => {
  it('says nothing when nothing validates the entity', () => {
    expect(chipOf(entity({ level: 'task', name: 'T' }))).toBeUndefined()
  })

  it('counts the verdicts that passed', () => {
    expect(chipOf(entity({ level: 'task', name: 'T', verdicts: { pass: 3, total: 4 } }))).toEqual({
      text: '3/4 passing',
      failing: true,
    })
  })

  // reason: one unproven check is the thing worth seeing from across a board,
  // so a chip with any failure in it reads as a failure.
  it('reads as passing only when every verdict passed', () => {
    expect(chipOf(entity({ level: 'task', name: 'T', verdicts: { pass: 2, total: 2 } }))?.failing).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/pane/board-rows.spec.ts`
Expected: FAIL — `Failed to resolve import './board-rows.ts'`.

- [ ] **Step 3: Implement**

Create `src/renderer/pane/board-rows.ts`:

```ts
/**
 * The columns the board draws, in order.
 *
 * Every status, always, whether or not anything is in it: an empty column is
 * information — it names a place work can go to — and a column set that
 * changed shape with the data would move under the reader.
 */
export const BOARD_STATUSES: readonly string[] = [
  'draft',
  'executing',
  'awaitingApproval',
  'done',
  'failed',
  'cancelled',
]

/** One entity, as this page receives it over the bridge. */
export interface EntityView {
  level: string
  folderPath: string
  name: string
  /** Empty for a test, which has none. */
  status: string
  children: EntityView[]
  /** How many of its own children are done, computed on read and never written. */
  progress: { done: number; total: number }
  /** How many acceptance criteria are ticked. */
  criteria: { done: number; total: number }
  /** How many of the tests that validate it passed. */
  verdicts: { pass: number; total: number }
}

/** One row of the board: a mission, or a campaign's own bugs. */
export interface LaneView {
  /** Unique across the board; the folder path, which already is. */
  key: string
  title: string
  folderPath: string
  /** The lane's own status. Empty for a bug lane, which is not an entity. */
  status: string
  kind: 'mission' | 'campaign-bugs'
  /** Cards by status, every status present. */
  columns: Record<string, EntityView[]>
}

/** One campaign and the lanes beneath it. */
export interface GroupView {
  campaign: EntityView
  lanes: LaneView[]
}

/** An empty column for every status, so a lane never has a missing one. */
function emptyColumns(): Record<string, EntityView[]> {
  const columns: Record<string, EntityView[]> = {}
  for (const status of BOARD_STATUSES) columns[status] = []
  return columns
}

/**
 * Put one card in the column its status names.
 *
 * A status the board does not draw goes in the first column rather than being
 * dropped: a card nobody can see is a card nobody can fix, and from `draft` it
 * can be dragged somewhere real. The store reports the same file as a finding,
 * so the state is named as well as shown.
 * @param columns - the lane's columns.
 * @param card - the entity to place.
 */
function place(columns: Record<string, EntityView[]>, card: EntityView): void {
  const column = BOARD_STATUSES.includes(card.status) ? card.status : BOARD_STATUSES[0]
  columns[column].push(card)
}

/**
 * Turn the board's tree into the rows and columns it is drawn as.
 *
 * Lanes are missions because a mission is the unit of work that has a shape —
 * a campaign is too big to read across and a task is a card. A campaign's own
 * bugs get a lane of their own so a bug filed against one is never homeless.
 *
 * Tests are never cards. They have no status, so there is no column they
 * belong in, and one placed in a column would read as work in flight — which
 * is the one thing a test is not.
 * @param campaigns - the board's campaigns, as read.
 * @returns one group per campaign, each with its lanes.
 */
export function groupBoard(campaigns: EntityView[]): GroupView[] {
  return campaigns.map((campaign) => {
    const lanes: LaneView[] = []
    const bugs = campaign.children.filter((child) => child.level === 'bug')
    for (const mission of campaign.children.filter((child) => child.level === 'mission')) {
      const columns = emptyColumns()
      for (const child of mission.children) {
        if (child.level === 'test') continue
        place(columns, child)
      }
      lanes.push({
        key: mission.folderPath,
        title: mission.name,
        folderPath: mission.folderPath,
        status: mission.status,
        kind: 'mission',
        columns,
      })
    }
    if (bugs.length > 0) {
      const columns = emptyColumns()
      for (const bug of bugs) place(columns, bug)
      lanes.push({
        key: `${campaign.folderPath}#bugs`,
        title: 'Bugs',
        folderPath: campaign.folderPath,
        status: '',
        kind: 'campaign-bugs',
        columns,
      })
    }
    return { campaign, lanes }
  })
}

/**
 * What a card says about the tests that prove it.
 *
 * Absent when nothing validates it — a chip reading `0/0` is a claim about
 * nothing, and every card would carry one. Any failure makes the whole chip
 * read as failing, because one unproven check is the thing worth seeing from
 * across a board.
 * @param entity - the card.
 * @returns the chip, or nothing when there is nothing to say.
 */
export function chipOf(entity: EntityView): { text: string; failing: boolean } | undefined {
  const { pass, total } = entity.verdicts
  if (total === 0) return undefined
  return { text: `${String(pass)}/${String(total)} passing`, failing: pass < total }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/renderer/pane/board-rows.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the test-is-never-a-card rule is load-bearing**

Delete the `if (child.level === 'test') continue` line. Re-run. Expected: "never makes a card of a test" fails. Restore.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.pane.json --noEmit`

```bash
git add src/renderer/pane/board-rows.ts src/renderer/pane/board-rows.spec.ts
git commit -m "feat(board): group a board into campaigns, lanes and columns"
```

---

### Task 2: Main's half — one read, four writes, one change event

Everything main does for these views, in one module so the views' contract with it is readable in one file.

**Files:**
- Create: `src/main/board-ipc.ts`
- Test: `src/main/board-ipc.spec.ts`

**Interfaces:**
- Consumes: `readBoard`, `type Board`, `type Entity`, `type Suite` from `./board/board-read`; `createEntity`, `setStatus`, `trashEntity` from `./board/board-write`; `boardRoot` from `./board/board-paths`.
- Produces:
  ```ts
  export interface BoardViewData { present: boolean; campaigns: EntityWire[]; tests: SuiteWire; findings: { folderPath: string; says: string }[] }
  export interface EntityWire { level: string; folderPath: string; name: string; status: string; children: EntityWire[]; progress: { done: number; total: number }; criteria: { done: number; total: number }; verdicts: { pass: number; total: number } }
  export interface SuiteWire { path: string; slug: string; suites: SuiteWire[]; tests: { folderPath: string; name: string; validates: { pass: number; total: number } }[] }
  export function boardFor(project: string | undefined): BoardViewData
  export function watchBoard(project: string | undefined, changed: () => void): () => void
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/board-ipc.spec.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardFor } from './board-ipc'

let project = ''
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-ipc-')))
  mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Write one board file.
 * @param path - the path within `.dsh/tasks/`.
 * @param body - the YAML body.
 */
function put(path: string, body: string): void {
  const full = join(project, '.dsh', 'tasks', path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

describe('boardFor', () => {
  it('reports no board when no project is open', () => {
    expect(boardFor(undefined)).toEqual({ present: false, campaigns: [], tests: { path: 'tests', slug: 'tests', suites: [], tests: [] }, findings: [] })
  })

  it('carries a campaign, its mission and its task', () => {
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: campaign\nstatus: executing\n')
    put('campaigns/q3/missions/m1/workitem.yaml', 'name: M1\nsubtype: mission\n')
    put('campaigns/q3/missions/m1/tasks/t1/workitem.yaml', 'name: T1\nsubtype: task\nstatus: done\nacceptance_criteria:\n  - text: it works\n    done: true\n')
    const board = boardFor(project)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].children[0].children[0].status).toBe('done')
  })

  // reason: the wire shape is what both views draw from, and it must carry
  // only what they draw — a whole `EntityFields` would put every criterion's
  // prose across the bridge on every keystroke-triggered redraw.
  it('carries counts rather than the fields they were counted from', () => {
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: campaign\n')
    put(
      'campaigns/q3/missions/m1/workitem.yaml',
      'name: M1\nsubtype: mission\nacceptance_criteria:\n  - text: a\n    done: true\n  - text: b\n    done: false\n',
    )
    const mission = boardFor(project).campaigns[0].children[0]
    expect(mission.criteria).toEqual({ done: 1, total: 2 })
    expect(mission).not.toHaveProperty('fields')
  })

  it('counts the verdicts on a workitem', () => {
    put('tests/login/test.yaml', 'name: Login\n')
    put('tests/logout/test.yaml', 'name: Logout\n')
    put(
      'campaigns/q3/workitem.yaml',
      'name: Q3\nsubtype: campaign\nvalidated_by:\n  - test: tests/login\n    result: pass\n  - test: tests/logout\n    result: fail\n    bug: campaigns/q3/bugs/b\n',
    )
    put('campaigns/q3/bugs/b/bug.yaml', 'name: B\n')
    expect(boardFor(project).campaigns[0].verdicts).toEqual({ pass: 1, total: 2 })
  })

  // reason: the tree shows the reverse direction — what a test validates —
  // and it is the only place that direction is visible.
  it('carries what each test validates, and how much of it passes', () => {
    put('tests/login/test.yaml', 'name: Login\n')
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: campaign\nvalidated_by:\n  - test: tests/login\n    result: pass\n')
    const test = boardFor(project).tests.tests[0]
    expect(test.name).toBe('Login')
    expect(test.validates).toEqual({ pass: 1, total: 1 })
  })

  it('carries nested suites', () => {
    put('tests/auth/oauth/login/test.yaml', 'name: Login\n')
    const tests = boardFor(project).tests
    expect(tests.suites[0].slug).toBe('auth')
    expect(tests.suites[0].suites[0].tests[0].name).toBe('Login')
  })

  it('carries the findings the store reported', () => {
    put('campaigns/q3/workitem.yaml', 'name: Q3\nsubtype: mission\n')
    expect(boardFor(project).findings.some((finding) => finding.says.includes('subtype'))).toBe(true)
  })

  // reason: reading a board must never create one — the same rule the store
  // keeps, and the views call this on every focus.
  it('creates nothing for a project with no board', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-board-bare-')))
    expect(boardFor(bare).present).toBe(false)
    expect(boardFor(bare).present).toBe(false)
    rmSync(bare, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/board-ipc.spec.ts`
Expected: FAIL — `Failed to resolve import './board-ipc'`.

- [ ] **Step 3: Implement**

Create `src/main/board-ipc.ts`:

```ts
import { watch, type FSWatcher } from 'node:fs'
import { boardRoot } from './board/board-paths'
import { readBoard, type Entity, type Suite } from './board/board-read'

/** One entity, cut to what the two views draw. */
export interface EntityWire {
  level: string
  folderPath: string
  name: string
  /** Empty for a test, which has none. */
  status: string
  children: EntityWire[]
  progress: { done: number; total: number }
  criteria: { done: number; total: number }
  verdicts: { pass: number; total: number }
}

/** One test, and how much of what it validates passes. */
export interface TestWire {
  folderPath: string
  name: string
  /** The reverse of a workitem's chip: what this test proves, and how much holds. */
  validates: { pass: number; total: number }
}

/** A suite, its sub-suites, and the tests directly inside it. */
export interface SuiteWire {
  path: string
  slug: string
  suites: SuiteWire[]
  tests: TestWire[]
}

/** The whole board, as the views receive it. */
export interface BoardViewData {
  present: boolean
  campaigns: EntityWire[]
  tests: SuiteWire
  findings: { folderPath: string; says: string }[]
}

/** An empty tests container, for a project with no board. */
function noTests(): SuiteWire {
  return { path: 'tests', slug: 'tests', suites: [], tests: [] }
}

/**
 * Cut one entity down to what is drawn.
 *
 * Counts rather than the fields they were counted from: a whole `EntityFields`
 * would carry every criterion's prose and every link's comment across the
 * bridge on every redraw, and the views render none of it. The file is one
 * click away for anyone who wants the rest.
 * @param entity - the entity as the store read it.
 * @returns the entity as a view draws it.
 */
function wire(entity: Entity): EntityWire {
  const criteria = entity.fields.acceptanceCriteria
  const verdicts = entity.fields.validatedBy
  return {
    level: entity.level,
    folderPath: entity.folderPath,
    name: entity.name,
    status: entity.status,
    children: entity.children.map(wire),
    progress: entity.progress,
    criteria: { done: criteria.filter((one) => one.done).length, total: criteria.length },
    verdicts: { pass: verdicts.filter((one) => one.result === 'pass').length, total: verdicts.length },
  }
}

/**
 * Cut the tests container down, counting what each test proves.
 *
 * The count runs the other way from a workitem's: a workitem asks how many of
 * its own checks hold, a test asks how much of what it covers holds. That
 * direction exists nowhere else, which is why the tree shows it.
 * @param suite - the suite as the store read it.
 * @param links - every workitem's links, flattened once for the whole board.
 * @returns the suite as the tree draws it.
 */
function wireSuite(suite: Suite, links: { test: string; result: string }[]): SuiteWire {
  return {
    path: suite.path,
    slug: suite.slug,
    suites: suite.suites.map((child) => wireSuite(child, links)),
    tests: suite.tests.map((test) => {
      const mine = links.filter((link) => link.test === test.folderPath)
      return {
        folderPath: test.folderPath,
        name: test.name,
        validates: { pass: mine.filter((link) => link.result === 'pass').length, total: mine.length },
      }
    }),
  }
}

/** Every link on the board, so a test's count is one pass rather than a walk per test. */
function allLinks(entities: Entity[]): { test: string; result: string }[] {
  const out: { test: string; result: string }[] = []
  const stack = [...entities]
  while (stack.length > 0) {
    const entity = stack.pop()!
    stack.push(...entity.children)
    for (const link of entity.fields.validatedBy) out.push({ test: link.test, result: link.result })
  }
  return out
}

/**
 * Read the open project's board, for both views.
 *
 * A full read every time, and never a cache: it is the store's own rule, the
 * read is milliseconds, and a cached board is a second thing that can disagree
 * with disk. Both views call this, so neither can be showing something the
 * other is not.
 * @param project - the open project's directory, or nothing when none is.
 * @returns the board, cut to what is drawn.
 */
export function boardFor(project: string | undefined): BoardViewData {
  if (project === undefined) return { present: false, campaigns: [], tests: noTests(), findings: [] }
  const board = readBoard(project)
  if (!board.present) return { present: false, campaigns: [], tests: noTests(), findings: board.findings }
  const links = allLinks(board.campaigns)
  return {
    present: true,
    campaigns: board.campaigns.map(wire),
    tests: wireSuite(board.tests, links),
    findings: board.findings,
  }
}

/**
 * Watch a project's board and say when it moved.
 *
 * Recursive over `.dsh/tasks/`, which is where every write lands — the
 * panel's own, the agent's through its tools, and a `git checkout`'s. Only the
 * first is observable directly, so the rest are watched for.
 *
 * A project with no board is watched for nothing rather than having one made:
 * the directory appears when something creates it, and the next focus reads it.
 * @param project - the open project's directory, or nothing when none is.
 * @param changed - called on every event; the caller debounces.
 * @returns a function that stops watching.
 */
export function watchBoard(project: string | undefined, changed: () => void): () => void {
  if (project === undefined) return () => {}
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(boardRoot(project), { recursive: true, persistent: false }, () => {
      changed()
    })
  } catch {
    // No board yet, or a filesystem that cannot watch recursively. Neither is
    // a failure: the views still re-read on focus and after their own writes.
    return () => {}
  }
  return () => {
    watcher?.close()
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board-ipc.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the cut is load-bearing**

In `wire`, add `fields: entity.fields,` to the returned object. Re-run. Expected: "carries counts rather than the fields they were counted from" fails. Remove it.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.json --noEmit`

```bash
git add src/main/board-ipc.ts src/main/board-ipc.spec.ts
git commit -m "feat(board): what main hands the views, and when it moved"
```

---

### Task 3: A third view in the side column

The seam. `SideView` gains a value, the rail gains a button, and a page gains a view — the same three moves that added the git panel, in the same files.

**Files:**
- Modify: `src/main/layout.ts`, `src/main/window.ts`, `src/main/index.ts`, `src/preload/shell.ts`, `src/renderer/shell.html`, `src/renderer/shell.js`, `package.json`
- Create: `src/renderer/tasks.html`
- Test: `src/main/layout.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SideView` becomes `'files' | 'git' | 'tasks'`; `views.tasks` exists; `shell:toggle-tasks` is a channel; `⌘⌥T` toggles it.

- [ ] **Step 1: Write the failing test**

Append to `src/main/layout.spec.ts`:

```ts
describe('the tasks view in the side column', () => {
  // reason: three views that are rarely read at once do not each deserve
  // permanent horizontal space, so the third joins the rotation rather than
  // becoming a fourth column.
  it('opens the column on the tasks view when it was showing something else', () => {
    expect(nextSideView({ open: true, view: 'git' }, 'tasks')).toEqual({ open: true, view: 'tasks' })
    expect(nextSideView({ open: false, view: 'files' }, 'tasks')).toEqual({ open: true, view: 'tasks' })
  })

  it('closes the column when the tasks button is pressed while it is showing', () => {
    expect(nextSideView({ open: true, view: 'tasks' }, 'tasks')).toEqual({ open: false, view: 'tasks' })
  })

  it('switches away from tasks without closing', () => {
    expect(nextSideView({ open: true, view: 'tasks' }, 'files')).toEqual({ open: true, view: 'files' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/layout.spec.ts`
Expected: FAIL — `'tasks'` is not assignable to `SideView`.

- [ ] **Step 3: Widen the type**

In `src/main/layout.ts`, change the type and its comment:

```ts
/** Which view the side column is showing. */
export type SideView = 'files' | 'git' | 'tasks'
```

and extend `SideColumnState`'s comment to say "the tree, the git panel and the board's tree are rarely read at once". `nextSideView` needs no change — its rule was never about how many views there are.

- [ ] **Step 4: Add the page**

Create `src/renderer/tasks.html`, modelled on `src/renderer/git.html` — read that file first and follow it exactly, including the vendored theme links and the comment style:

```html
<!doctype html>
<meta charset="utf-8">
<title>Tasks</title>
<!-- The harness's own tokens, vendored; see vendor/dsh-theme/README.md. -->
<link rel="stylesheet" href="theme/base.css">
<link rel="stylesheet" href="theme/design-platform.css">
<link rel="stylesheet" href="pane.css">
<body class="files">
<main class="pane">
  <div class="column-head">
    <span class="project-name" id="tasks-title">Tasks</span>
    <span class="head-spacer"></span>
  </div>
  <section class="panel">
    <!-- Hidden until the first read lands: the panel would otherwise flash a
         message about a project it has not looked at yet. -->
    <p class="empty" id="tasks-empty" hidden></p>
    <!-- What the board could not read. A live region, because a file the
         board is silently missing is the thing worth announcing. -->
    <p class="git-note" id="tasks-note" role="status" hidden></p>
    <div id="tasks-tree"></div>
  </section>
</main>
<script src="tasks-bundle.js"></script>
```

In `package.json`, add `src/renderer/tasks.html` to the `cp` list in `build:renderer`, and add an esbuild entry to `build:pane` for `src/renderer/pane/tasks-tree.ts` → `dist/renderer/tasks-bundle.js`, copying the flags the `git.ts` entry beside it uses.

- [ ] **Step 5: Add the view, the rail button and the shortcut**

In `src/main/window.ts`: add `tasks: WebContentsView` to the views interface with a comment saying why it is a view of its own rather than a panel inside the tree's page (the same reason `git` gives — a view given no bounds keeps what it drew, so switching back costs no reload); construct it beside `git`, loading `tasks.html`; add it to the visibility record beside `git: columns.files.open && showingGit`, with `showingTasks`; add `toggleTasks(): void` to the panes interface and a menu item `{ label: 'Toggle Tasks', accelerator: 'CmdOrCtrl+Alt+T', click: panes.toggleTasks }` after the Source Control one.

In `src/main/index.ts`: wire `ipcMain.on('shell:toggle-tasks', () => { toggleSideView('tasks') })` beside `shell:toggle-git`; add `'tasks'` to the stored-view sanitiser that currently reads `side.view === 'git' ? 'git' : 'files'`, so a stored `tasks` survives a restart; and include `views.tasks.webContents` wherever `views.git.webContents` is listed for theme and app-page treatment.

In `src/preload/shell.ts`: `toggleTasks: () => ipcRenderer.send('shell:toggle-tasks'),` beside `toggleGit`.

In `src/renderer/shell.html`: a rail button after `rail-git`, following that button's exact markup:

```html
  <button type="button" id="rail-tasks" class="rail-button" aria-pressed="false" aria-label="Tasks" title="Tasks (⌘⌥T)"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M1.6 6.1h12.8" stroke="currentColor" stroke-width="1.3"/><path d="M5.9 6.1v7.5" stroke="currentColor" stroke-width="1.3"/><path d="M10.1 6.1v7.5" stroke="currentColor" stroke-width="1.3"/></svg></button>
```

In `src/renderer/shell.js`: set its `aria-pressed` from `places.open.tasks` beside the git line, and add the click handler calling `window.shell.toggleTasks()`.

- [ ] **Step 6: Run the tests and both typechecks**

Run: `npx vitest run src/main/layout.spec.ts`, then `npm test`, then `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit`
Expected: all pass. `tasks-tree.ts` does not exist yet, so `npm run build` would fail — that is Task 4's deliverable and is expected here.

- [ ] **Step 7: Commit**

```bash
git add src/main/layout.ts src/main/layout.spec.ts src/main/window.ts src/main/index.ts src/preload/shell.ts src/renderer/shell.html src/renderer/shell.js src/renderer/tasks.html package.json
git commit -m "feat(board): a third view in the side column, and the rail button for it"
```

---

### Task 4: The tree

> **A note on these two tasks.** Tasks 4 and 5 specify their modules as a
> behaviour contract plus a complete test file, rather than as code to
> transcribe — they are 300-line renderer modules and writing them out would
> double this document without adding precision the tests do not already
> carry. **The spec file is the contract**: every class name, id, call
> signature and piece of copy an implementer needs is either in the test or in
> the bullets, and `src/renderer/pane/git.ts` is the file to follow for shape.
> Dispatch these two on a stronger model than the rest.


**Files:**
- Create: `src/renderer/pane/tasks-tree.ts`
- Modify: `src/preload/pane.ts`, `src/renderer/pane/bridge.ts`, `src/main/index.ts`
- Test: `src/renderer/pane/tasks-tree.spec.ts`

**Interfaces:**
- Consumes: `BOARD_STATUSES`, `type EntityView` from `./board-rows.ts`; `boardFor`, `watchBoard` from main. `EntityWire` and `EntityView` are the same shape under two names, deliberately: the renderer must not import from `src/main/`, which is the rule `git-rows.ts` and `git-model.ts` already follow. They are structurally assignable, so no conversion is needed.
- Produces: the channels `tasks:read` (invoke → `BoardViewData`), `tasks:changed` (main → both views), `tasks:reveal` (renderer → main → the board), `tasks:open-file` (renderer → main → the editor).

- [ ] **Step 1: Wire the channels in main**

In `src/main/index.ts`, beside the git channels:

```ts
    ipcMain.handle('tasks:read', () => boardFor(currentProject?.path))
    // The tree names a folder path; main hands it to the board's panel, which
    // brings its own tab forward. A reveal that scrolled a panel nobody could
    // see would look like nothing happening.
    ipcMain.on('tasks:reveal', (_event, folderPath: string) => {
      if (views === undefined || views.window.isDestroyed()) return
      if (!columns.editor.open) {
        setColumn('editor', { open: true })
        storeColumns()
      }
      views.pane.webContents.send('tasks:reveal', folderPath)
    })
```

and a debounced change notice modelled on `notifyGitChanged` — read that function and follow it, including its settle delay and its `unref`:

```ts
/** The pending `tasks:changed`, so a burst of writes arrives as one. */
let tasksNotify: ReturnType<typeof setTimeout> | undefined

/**
 * Tell both board views to read themselves again, once the writes have settled.
 *
 * An agent planning a campaign writes dozens of files in a second through its
 * tools; without this, each one is a full re-read and a redraw in two views.
 */
function notifyTasksChanged(): void {
  if (views === undefined || views.window.isDestroyed()) return
  if (tasksNotify !== undefined) clearTimeout(tasksNotify)
  tasksNotify = setTimeout(() => {
    tasksNotify = undefined
    if (views === undefined || views.window.isDestroyed()) return
    views.tasks.webContents.send('tasks:changed')
    views.pane.webContents.send('tasks:changed')
  }, GIT_SETTLE_MS)
  tasksNotify.unref?.()
}
```

Call `watchBoard(currentProject?.path, notifyTasksChanged)` wherever the project's other watchers are started, keeping its returned stopper beside them and calling it where they are closed.

In `src/preload/pane.ts`:

```ts
  readTasks: () => ipcRenderer.invoke('tasks:read'),
  revealOnBoard: (folderPath: string) => ipcRenderer.send('tasks:reveal', folderPath),
  openTaskFile: (folderPath: string, file: string) => ipcRenderer.send('tasks:open-file', folderPath, file),
  onTasksChanged: (listener: () => void) => {
    ipcRenderer.on('tasks:changed', () => {
      listener()
    })
  },
  onReveal: (listener: (folderPath: string) => void) => {
    ipcRenderer.on('tasks:reveal', (_event, folderPath: string) => listener(folderPath))
  },
```

and declare all five in `src/renderer/pane/bridge.ts`, with `readTasks(): Promise<BoardViewData>` where `BoardViewData` is re-declared locally the way `ProjectGitView` already is — the renderer must not import from `src/main/`.

Add `tasks:open-file`, which turns a board folder into the file the editor opens:

```ts
    // A card's click opens the entity's own YAML. The file name comes from the
    // level, which only main knows — the renderer holds a folder path and
    // nothing else, which is what keeps `fileFor` on one side of the bridge.
    ipcMain.on('tasks:open-file', (_event, folderPath: string, file: string) => {
      const project = currentProject?.path
      if (project === undefined) return
      const dir = resolveInBoard(project, folderPath)
      if (dir === undefined) return
      if (!['workitem.yaml', 'bug.yaml', 'test.yaml'].includes(file)) return
      openInPane(project, join(BOARD_DIR, folderPath, file))
    })
```

- [ ] **Step 2: Write the failing test**

Create `src/renderer/pane/tasks-tree.spec.ts`. Read `src/renderer/pane/git.spec.ts` first and follow its harness shape exactly — a `page()` that writes the minimal markup, a stub bridge object assigned to `globalThis.pane`, and a `load()` that does `vi.resetModules()` then `await import('./tasks-tree.ts')` and turns the microtask queue.

```ts
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
  return { present: true, campaigns: [], tests: { path: 'tests', slug: 'tests', suites: [], tests: [] }, findings: [], ...over }
}

/** One entity for a stub board. */
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

interface Stub {
  readTasks: () => Promise<unknown>
  onTasksChanged: (listener: () => void) => void
  revealOnBoard: (folderPath: string) => void
  openTaskFile: (folderPath: string, file: string) => void
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
    openTaskFile: (folderPath, file) => calls.push(['open', folderPath, file]),
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/renderer/pane/tasks-tree.spec.ts`
Expected: FAIL — `Failed to resolve import './tasks-tree.ts'`.

- [ ] **Step 4: Implement the tree**

Create `src/renderer/pane/tasks-tree.ts`. Follow `src/renderer/pane/git.ts` for its shape — an `el(id)` helper that throws when the page does not declare an id, a module-level `latest`, a `draw()` that rebuilds into one container, a `refresh()` that is the only caller of the bridge's read, and `followHarnessTheme` at the top. Its behaviour:

- A `Set<string>` of collapsed folder paths, keyed by path so a redraw keeps what was open.
- One row per entity: a twisty when it has children, a status chip (omitted for a test, which has none), the name, and `done/total` when `progress.total > 0`.
- Beneath the campaigns, a `Tests` root drawing suites and tests. A test row shows its name and `pass/total` from `validates` when `total > 0`.
- Clicking a row calls `window.pane.revealOnBoard(folderPath)`. Nothing else writes.
- `#tasks-empty` carries one of: `This project has no board yet. Ask the agent to plan something, or create a campaign.` when `present` is false; `The board is empty.` when it is present and holds nothing.
- `#tasks-note` says `N files could not be read.` when `findings` is non-empty, hidden otherwise.
- `window.pane.onTasksChanged(() => { void refresh() })` at the end, then `void refresh()`.

- [ ] **Step 5: Run the tests and both typechecks**

Run: `npx vitest run src/renderer/pane/tasks-tree.spec.ts`, then `npm test`, then both typechecks.
Expected: all pass.

- [ ] **Step 6: Prove the tree writes nothing**

Add `window.pane.openTaskFile(folderPath, 'workitem.yaml')` to the row's click handler. Re-run. Expected: "never writes anything" fails. Remove it.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/pane/tasks-tree.ts src/renderer/pane/tasks-tree.spec.ts src/preload/pane.ts src/renderer/pane/bridge.ts src/main/index.ts
git commit -m "feat(board): the tree, which navigates and changes nothing"
```

---

### Task 5: The board panel

> **A note on these two tasks.** Tasks 4 and 5 specify their modules as a
> behaviour contract plus a complete test file, rather than as code to
> transcribe — they are 300-line renderer modules and writing them out would
> double this document without adding precision the tests do not already
> carry. **The spec file is the contract**: every class name, id, call
> signature and piece of copy an implementer needs is either in the test or in
> the bullets, and `src/renderer/pane/git.ts` is the file to follow for shape.
> Dispatch these two on a stronger model than the rest.


**Files:**
- Create: `src/renderer/pane/board.ts`
- Modify: `src/renderer/pane/tabs.ts`, `src/renderer/pane/main.ts`, `src/renderer/pane.html`, `src/renderer/pane.css`
- Test: `src/renderer/pane/board.spec.ts`, `src/renderer/pane/tabs.spec.ts`

**Interfaces:**
- Consumes: `groupBoard`, `chipOf`, `BOARD_STATUSES` from `./board-rows.ts`; the bridge from Task 4.
- Produces: `PaneTab` becomes `'editor' | 'web' | 'board'`.

- [ ] **Step 1: Write the failing test for the tab**

Append to `src/renderer/pane/tabs.spec.ts`:

```ts
describe('the board tab', () => {
  it('is one of the pane’s tabs', () => {
    expect([...PANE_TABS]).toEqual(['editor', 'web', 'board'])
  })

  // reason: the web view is a WebContentsView stacked over the pane's bounds,
  // not an element in this document — so any tab but Web must hide it, or it
  // covers whatever took its place.
  it('hides the web view when the board is shown', () => {
    const shown: boolean[] = []
    selectTab('board', { select: () => {}, reveal: () => {}, showWebView: (visible) => shown.push(visible) })
    expect(shown).toEqual([false])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/pane/tabs.spec.ts`
Expected: FAIL — `PANE_TABS` has two entries.

- [ ] **Step 3: Add the tab**

In `src/renderer/pane/tabs.ts`, extend the type and the list, and extend the type's comment to say the board is a panel of this document while the web view is not:

```ts
export type PaneTab = 'editor' | 'web' | 'board'

export const PANE_TABS: readonly PaneTab[] = ['editor', 'web', 'board']
```

In `src/renderer/pane.html`, a tab button after `tab-web` and a panel after `panel-web`, following their markup exactly:

```html
    <button type="button" role="tab" id="tab-board" aria-controls="panel-board" aria-selected="false" tabindex="-1" class="tab">Board</button>
```

```html
  <section id="panel-board" role="tabpanel" aria-labelledby="tab-board" class="panel">
    <p class="empty" id="board-empty" hidden></p>
    <p class="git-note" id="board-note" role="status" hidden></p>
    <div id="board-groups"></div>
    <!-- Closed by its own controls and by nothing else; see the spec's
         "Creating something opens a modal". -->
    <div id="board-modal" class="board-modal" role="dialog" aria-modal="true" aria-labelledby="board-modal-title" hidden>
      <form class="board-modal-form" id="board-modal-form">
        <p class="board-modal-title" id="board-modal-title"></p>
        <label class="board-modal-field"><span>Name</span><input type="text" id="board-modal-name"></label>
        <label class="board-modal-field"><span id="board-modal-second-label"></span><input type="text" id="board-modal-second"></label>
        <p class="board-modal-error" id="board-modal-error" role="status" hidden></p>
        <div class="board-modal-actions">
          <button type="button" id="board-modal-cancel" class="board-modal-button">Cancel</button>
          <button type="submit" id="board-modal-create" class="board-modal-button">Create</button>
        </div>
      </form>
    </div>
  </section>
```

In `src/renderer/pane/main.ts`, add `import './board.ts'` beside the other panel imports.

- [ ] **Step 4: Write the failing test for the board**

Create `src/renderer/pane/board.spec.ts`, following `git.spec.ts`'s harness shape as Task 4's spec does. Its `page()` writes the panel markup above. Its stub bridge answers `readTasks` and records `createBoardEntity`, `setBoardStatus`, `trashBoardEntity` and `openTaskFile`.

```ts
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
```

Write the `oneMission`, `bridge`, `load` and `drop` helpers in that file. `drop(folderPath, status)` dispatches a `dragstart` on the card carrying `folderPath` in its `dataTransfer`, then a `drop` on the column element for `status` — jsdom has no real drag, so construct the events and set `dataTransfer` yourself.

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/renderer/pane/board.spec.ts`
Expected: FAIL — `Failed to resolve import './board.ts'`.

- [ ] **Step 6: Implement the board**

Create `src/renderer/pane/board.ts`, following `git.ts`'s shape. Its behaviour:

- `draw()` builds groups with `groupBoard`, a heading per campaign, a row per lane, and `BOARD_STATUSES.length` columns per lane with class `board-column board-column-<status>`.
- A card is a `<button type="button" class="board-card" draggable="true">` carrying `data-folder`. Its content: the name, `bug` when its level is one, `N/M` criteria when `criteria.total > 0`, and a `.board-chip` from `chipOf` when there is one, with a `board-chip-failing` class when it is failing.
- Clicking a card calls `window.pane.openTaskFile(folderPath, file)` where `file` is `bug.yaml` for a bug and `workitem.yaml` otherwise.
- `dragstart` puts the folder path in `event.dataTransfer`. A column's `dragover` calls `preventDefault`; its `drop` reads the path and calls `window.pane.setBoardStatus(folderPath, status)`. **Nothing moves on `dragenter` or `dragover`** — the card is moved by the redraw that follows a successful write.
- A refused write writes the reason into `#board-note` and redraws from `latest`, which puts the card back where the file says it is.
- Each lane carries a `.board-lane-add` button; a campaign's bug lane's button creates a bug, a mission lane's a task.
- A card's `contextmenu` reveals a `.board-card-delete` control on that card, which calls `window.pane.trashBoardEntity(folderPath)`. Main confirms it before the store is touched, so the renderer does not ask twice.
- `#board-note` carries two different things and never both: a write's refusal, and — when there is no refusal outstanding and `findings` is non-empty — `N files could not be read. Open the tree to see which.` The board cannot show a finding against the entity it names, because such an entity is by definition not on the board.
- The modal: `open(kind, parent)` fills the title and the second field's label (`First acceptance criterion` for a task, `What happened` for a bug), shows it, and focuses the name. **Its own click handler calls `stopPropagation`; there is no backdrop handler and no `keydown` handler that closes it.** Cancel and the close control hide it and clear it. Submit calls `window.pane.createBoardEntity(level, parent, name, second)` and, on failure, keeps everything and writes the reason into `#board-modal-error`.
- `window.pane.onReveal((folderPath) => …)` scrolls the matching lane into view, adds `board-lane-revealed` to it, and selects the Board tab.
- `window.pane.onTasksChanged(() => { void refresh() })`, then `void refresh()`.

Add the three write methods to `src/preload/pane.ts` and `bridge.ts` — `createBoardEntity`, `setBoardStatus`, `trashBoardEntity` — and their `ipcMain.handle` channels in `index.ts`, each returning `{ ok, reason? }` from the store's function and each calling `notifyTasksChanged()` afterwards. `trashBoardEntity` goes behind a `dialog.showMessageBox` confirmation naming the entity, the way `git:discard` already does.

- [ ] **Step 7: Style it**

In `src/renderer/pane.css`, add the board's rules beside the existing panel rules — columns in a horizontally scrolling flex row, lanes stacked, cards in the harness's own tokens following `.git-row`'s colour treatment, and the modal centred over the panel with a backdrop that is `pointer-events: none` so it cannot be clicked through *or* clicked on. Read the file's existing rules first and match their spacing, tokens and comment voice.

- [ ] **Step 8: Run everything**

Run: `npx vitest run src/renderer/pane/board.spec.ts src/renderer/pane/tabs.spec.ts`, then `npm test`, then both typechecks, then `npm run build`.
Expected: all pass, and the build produces `dist/renderer/tasks-bundle.js`.

- [ ] **Step 9: Prove the drop rule is load-bearing**

Move the `setBoardStatus` call from the `drop` handler to `dragover`. Re-run. Expected: "sets the status of the card that was dropped, once" fails with many calls. Restore.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/pane/board.ts src/renderer/pane/board.spec.ts src/renderer/pane/tabs.ts src/renderer/pane/tabs.spec.ts src/renderer/pane.html src/renderer/pane/main.ts src/renderer/pane.css src/preload/pane.ts src/renderer/pane/bridge.ts src/main/index.ts
git commit -m "feat(board): the swimlane board, its drag, and the modal that will not vanish"
```

---

### Task 6: The README, and the shortcut nobody documented

**Files:**
- Modify: `README.md`, `docs/notes/task-board-views.md`

- [ ] **Step 1: Write the README paragraph**

In the section describing the side column and the rail, add:

```markdown
The board has two surfaces. `⌘⌥T` opens its tree in the side column — campaigns,
missions, tasks and bugs, with the tests that prove them under their own root.
The Board tab in the content column shows the same work as a swimlane board:
one lane per mission, one column per status, and a card dragged between them
sets that entity's status and nothing else's.
```

- [ ] **Step 2: Record the shortcut beside the others**

Wherever the README lists `⌘⌥B`, `⌘⌥G`, `⌘⌥W` and `⌘⌥J`, add `⌘⌥T`.

- [ ] **Step 3: Note what shipped**

In `docs/notes/task-board-views.md`, under *Deliberately not in this*, nothing changes — but check every other section against what was built and correct any sentence that is now untrue. A spec that drifts from the code is worse than no spec.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/notes/task-board-views.md
git commit -m "docs(board): the two surfaces, and the shortcut that opens the tree"
```

---

## Manual verification

None of this is provable by a test that mocks the store, so it is checked by hand once in a packaged build (`npm run pack`; quit any running copy from the tray first, or the single-instance lock makes the new build exit immediately):

1. Open a project with no `.dsh/tasks/`. Press `⌘⌥T`: the tree words it and **creates nothing**.
2. Ask the agent to plan a campaign with two missions and a few tasks. Both views should redraw without being asked.
3. Drag a card to `done`. Confirm the YAML changed, the mission's status did **not**, and the lane's progress moved.
4. Drag a card while the file is read-only. Confirm it goes back and the note says why.
5. Click a lane's `+`, type a name, then click outside the modal and press Escape. It must still be open with the text in it.
6. Click a card. Its `workitem.yaml` opens in the editor beside the board.
7. Click a row in the tree. The Board tab comes forward and the lane is highlighted.
8. Break a `workitem.yaml` by hand. Both views should say a file could not be read, and neither should lose the rest of the board.
