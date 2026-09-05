# Board: Five Statuses, Folding and Hiding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the board's six statuses with the five that say what is true of the work, then make campaigns and missions fold, let a campaign be hidden, sort what is left, and give both views a design pass.

**Architecture:** The vocabulary lands first, in the store's schema, because every column downstream is drawn from it. Sorting and the closed-campaign rule go in `board-rows.ts`, which is pure and already tested. Folding is per-session state in the renderer; hiding is a decision and persists per project in `desktop.json`. The design pass is CSS plus a two-line card, and it covers the tree as well as the board so the two read as one feature.

**Tech Stack:** TypeScript (CommonJS main, `.ts`-suffixed pane bundle), Vitest with jsdom for the renderer, Electron IPC.

**Spec:** `docs/notes/task-board.md` for the vocabulary, `docs/notes/task-board-views.md` for the views. Read both.

## Global Constraints

- **No formatter is configured.** Do NOT run `prettier`, `eslint --fix`, or any other formatter. Match the surrounding style by hand: 2-space indent, **no semicolons**, **single quotes**, ~120-column lines.
- **Stage only the files your task names.** Never `git add -A`, `git add .`, or `git commit -a`. The repo root holds untracked `index.js` and `tree-menu.js` belonging to the user, which must never be committed.
- **Every exported symbol carries a JSDoc block** with `@param` and `@returns`, saying *why*, not *what*.
- **The statuses are exactly `idea`, `backlog`, `executing`, `validation`, `done`, in that order.** Work moves left to right. The set is fixed: an unknown status is a finding, never a new column.
- **There is no `failed` and no `cancelled` status.** But `failed` is also an ordinary English word all over this repo — in test output, in error messages, in a link's `fail` verdict, in `git`'s own vocabulary. **Removing the status must not touch any of those.** A global search-and-replace on the word will break unrelated code; change only the sites that are the board's own status vocabulary.
- **A link's result set — `pass`, `fail`, `not_run` — is untouched.** It is a different vocabulary and never mixes with statuses.
- **Nothing on disk is migrated.** A board already carrying `draft` or `cancelled` reports a finding and its card lands in the first column, where it is visible and can be dragged somewhere real. Reading never writes.
- **Nothing infers a status.** No rollup, no cascade.
- **A test is never a card**, and has no status.
- **Drag writes on drop, never on hover.** A failed write puts the card back and says why.
- **The create modal closes on Cancel and its close control and on nothing else.** `pointer-events: none` on an overlay means click-through — the opposite of what it reads like. `board.spec.ts` pins this by reading `pane.css` from disk, because jsdom does not hit-test. Do not undo that.
- Commands: `npm test`, `npx vitest run <file>`, `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p tsconfig.pane.json --noEmit`, `npm run build`. All clean before every commit.

---

## File Structure

**Modified:**

| File | What changes |
| --- | --- |
| `src/main/board/entity-schema.ts` | `EntityStatus`, `ENTITY_STATUSES`, the `dumpEntity` default |
| `src/main/view-mcp.ts` | Tool copy that names statuses; the render's column vocabulary |
| `src/renderer/pane/board-rows.ts` | `BOARD_STATUSES`, campaign sorting, the closed rule |
| `src/renderer/pane/board.ts` | Folding, hiding, the hidden control, the two-line card, the reveal's unfold |
| `src/renderer/pane/tasks-tree.ts` | Status labels |
| `src/renderer/pane.css` | The pass over both views |
| `src/main/config.ts`, `src/main/index.ts`, `src/preload/pane.ts`, `src/renderer/pane/bridge.ts` | Hidden campaigns, persisted per project |

Plus the spec files' own tests, and `README.md`.

---

### Task 1: Five statuses

The vocabulary, in the store. Everything downstream draws its columns from this, so it lands alone and first.

**Files:**
- Modify: `src/main/board/entity-schema.ts`, `src/main/board/entity-schema.spec.ts`, `src/main/board/board-read.spec.ts`, `src/main/board/board-write.spec.ts`, `src/main/view-mcp.ts`, `src/main/view-mcp.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type EntityStatus = 'idea' | 'backlog' | 'executing' | 'validation' | 'done'
  export const ENTITY_STATUSES: readonly EntityStatus[]   // in that order
  ```
  `dumpEntity`'s default status becomes `'idea'`.

- [ ] **Step 1: Write the failing test**

Replace the status assertion in `src/main/board/entity-schema.spec.ts`'s `describe('the vocabularies', …)` and add the rest:

```ts
  it('has exactly the five statuses the board draws, in the order work moves', () => {
    expect([...ENTITY_STATUSES]).toEqual(['idea', 'backlog', 'executing', 'validation', 'done'])
  })

  // reason: failure is not a resting place. Work that fails goes back to
  // `executing`, and what went wrong is already in a bug or a test verdict —
  // a status meaning "this went wrong once" is stale the day work resumes.
  it('has no failed and no cancelled', () => {
    expect(ENTITY_STATUSES).not.toContain('failed')
    expect(ENTITY_STATUSES).not.toContain('cancelled')
  })

  // reason: a link's verdict is a different question from a status — how far
  // work has got, versus whether a check held — and the two vocabularies must
  // not drift into each other.
  it('keeps a link result vocabulary of its own, still carrying fail', () => {
    expect([...LINK_RESULTS]).toEqual(['pass', 'fail', 'not_run'])
  })
```

and change the default-status test:

```ts
  it('defaults a missing status to idea rather than omitting it', () => {
    expect(dumpEntity('task', loadEntity('name: T\n'))).toContain('status: idea')
    expect(dumpEntity('bug', loadEntity('name: B\n'))).toContain('status: idea')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/board/entity-schema.spec.ts`
Expected: FAIL — the set is still the old six and the default is `draft`.

- [ ] **Step 3: Implement**

In `src/main/board/entity-schema.ts`:

```ts
/**
 * The set an entity's `status` field is drawn from.
 *
 * Each name says what is true of the work rather than what someone means to
 * do about it: an `idea` is worth writing down and nobody has committed to
 * it, `backlog` is committed but not started, `executing` is being done,
 * `validation` is done being done and not yet believed, and `done` is
 * finished with.
 */
export type EntityStatus = 'idea' | 'backlog' | 'executing' | 'validation' | 'done'

/**
 * The five statuses, in the order work moves through them.
 *
 * The order is the board's column order, and it is left to right with nowhere
 * else to go. There is no `failed`: failure is not a resting place, and what
 * went wrong lives in a bug or a test's verdict, where it can say something
 * useful. There is no `cancelled` either — abandoned work is still work you
 * are finished with, and why belongs in the entity's notes.
 */
export const ENTITY_STATUSES: readonly EntityStatus[] = ['idea', 'backlog', 'executing', 'validation', 'done']
```

In `dumpEntity`, change `o.status = f.status ?? 'draft'` to `o.status = f.status ?? 'idea'`.

- [ ] **Step 4: Fix the fixtures the rename breaks, without weakening a single assertion**

`board-read.spec.ts`, `board-write.spec.ts` and `view-mcp.spec.ts` write statuses into YAML fixtures and assert on them. Change each **fixture value** to the new vocabulary — `draft` → `idea`, `awaitingApproval` → `validation`, `cancelled` and `failed` → whichever of the five the test is actually about. Do not change what any test asserts, only the words it uses. If a test exists specifically to exercise `failed` or `cancelled` as a status, it should now exercise `done`, and its name should say so.

**Read every hit before you change it.** `grep -rn 'failed' src/main/board src/main/view-mcp*` will return matches that are English — "the write failed", "a failing link", `result: 'fail'`. Those stay. The only ones that change are a board entity's `status:` value and a member of the status list.

- [ ] **Step 5: Update the tool copy**

`board_status`'s description interpolates `ENTITY_STATUSES.join(', ')`, so it updates itself — but read every board tool's description and fix any prose that names a status by hand or implies six. In particular, `board_create`'s and `board_read`'s copy should not describe a vocabulary that no longer exists.

- [ ] **Step 6: Run everything**

Run: `npm test`, then `npx tsc -p tsconfig.json --noEmit`, then `npx tsc -p tsconfig.pane.json --noEmit`
Expected: `board-rows.spec.ts` in the renderer still fails — its `BOARD_STATUSES` is Task 2's. Everything under `src/main/` passes.

- [ ] **Step 7: Prove the rename is load-bearing**

Add `'failed'` back to `ENTITY_STATUSES`. Re-run `npx vitest run src/main/board/entity-schema.spec.ts`. Expected: "has no failed and no cancelled" fails. Remove it.

- [ ] **Step 8: Commit**

```bash
git add src/main/board/entity-schema.ts src/main/board/entity-schema.spec.ts src/main/board/board-read.spec.ts src/main/board/board-write.spec.ts src/main/view-mcp.ts src/main/view-mcp.spec.ts
git commit -m "feat(board): five statuses that say what is true of the work"
```

---

### Task 2: Sorting, and the campaign that closes itself

The pure half of the view change: which campaigns the board shows and in what order.

**Files:**
- Modify: `src/renderer/pane/board-rows.ts`, `src/renderer/pane/board-rows.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const BOARD_STATUSES: readonly string[]          // the five, in order
  export const CLOSED: readonly string[]                  // ['done']
  export function statusLabel(status: string): string     // 'validation' → 'Validation'
  export function groupBoard(campaigns: EntityView[]): GroupView[]   // now sorted, closed dropped
  export function closedCampaigns(campaigns: EntityView[]): EntityView[]
  ```

- [ ] **Step 1: Write the failing test**

Replace `board-rows.spec.ts`'s `BOARD_STATUSES` test and append:

```ts
describe('BOARD_STATUSES', () => {
  it('is the five statuses in the order work moves', () => {
    expect([...BOARD_STATUSES]).toEqual(['idea', 'backlog', 'executing', 'validation', 'done'])
  })
})

describe('statusLabel', () => {
  // reason: a column heading is a label, not a field name. The stored word is
  // the store's business; how it reads is the view's.
  it('renders a status as a heading rather than as a key', () => {
    expect(statusLabel('validation')).toBe('Validation')
    expect(statusLabel('backlog')).toBe('Backlog')
  })

  it('leaves a status it does not know alone rather than inventing a label', () => {
    expect(statusLabel('awaitingApproval')).toBe('awaitingApproval')
  })
})

describe('groupBoard sorting', () => {
  // reason: what needs you, above what is waiting. A board that reordered as
  // statuses changed would be one nobody could build a habit around, which is
  // why the order within a status is alphabetical and not anything else.
  it('sorts campaigns by status, then by name', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Zebra', folderPath: 'campaigns/z', status: 'idea' }),
      entity({ level: 'campaign', name: 'Beta', folderPath: 'campaigns/b', status: 'executing' }),
      entity({ level: 'campaign', name: 'Alpha', folderPath: 'campaigns/a', status: 'executing' }),
      entity({ level: 'campaign', name: 'Gamma', folderPath: 'campaigns/g', status: 'validation' }),
      entity({ level: 'campaign', name: 'Delta', folderPath: 'campaigns/d', status: 'backlog' }),
    ])
    expect(groups.map((group) => group.campaign.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Zebra'])
  })

  it('puts a campaign with an unknown status last rather than dropping it', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Odd', folderPath: 'campaigns/o', status: 'weird' }),
      entity({ level: 'campaign', name: 'Live', folderPath: 'campaigns/l', status: 'executing' }),
    ])
    expect(groups.map((group) => group.campaign.name)).toEqual(['Live', 'Odd'])
  })
})

describe('the campaign that closes itself', () => {
  // reason: finished work does not need a decision. It is not deleted and not
  // special — `closedCampaigns` is what puts it in the list you get it back from.
  it('leaves a done campaign off the board', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Shipped', folderPath: 'campaigns/s', status: 'done' }),
      entity({ level: 'campaign', name: 'Live', folderPath: 'campaigns/l', status: 'executing' }),
    ])
    expect(groups.map((group) => group.campaign.name)).toEqual(['Live'])
  })

  it('names the ones it left off, so they can be got back', () => {
    const closed = closedCampaigns([
      entity({ level: 'campaign', name: 'Shipped', folderPath: 'campaigns/s', status: 'done' }),
      entity({ level: 'campaign', name: 'Live', folderPath: 'campaigns/l', status: 'executing' }),
    ])
    expect(closed.map((campaign) => campaign.name)).toEqual(['Shipped'])
  })

  // reason: a done MISSION is still work under a live campaign, and its lane
  // is where you see it landed. Only a campaign closes itself.
  it('keeps the lane of a done mission on the board', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Live',
        folderPath: 'campaigns/l',
        status: 'executing',
        children: [entity({ level: 'mission', name: 'M1', folderPath: 'campaigns/l/missions/m1', status: 'done' })],
      }),
    ])
    expect(groups[0].lanes.map((lane) => lane.title)).toEqual(['M1'])
  })
})
```

Add `CLOSED`, `statusLabel` and `closedCampaigns` to the file's import.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/pane/board-rows.spec.ts`
Expected: FAIL — `statusLabel` and `closedCampaigns` do not exist and the status list is the old six.

- [ ] **Step 3: Implement**

In `src/renderer/pane/board-rows.ts`, replace `BOARD_STATUSES` and add the rest:

```ts
/**
 * The columns the board draws, in the order work moves through them.
 *
 * Every status, always, whether or not anything is in it: an empty column is
 * information — it names a place work can go to — and a column set that
 * changed shape with the data would move under the reader.
 *
 * Declared here as well as in main's schema because the renderer must not
 * import from `src/main/`; `entity-schema.spec.ts` and this file's own test
 * each pin the list, so the two cannot drift without one of them failing.
 */
export const BOARD_STATUSES: readonly string[] = ['idea', 'backlog', 'executing', 'validation', 'done']

/**
 * The statuses that take a campaign off the board.
 *
 * A list of one, written as a list because that is what it is: the rule is
 * "these statuses are finished with", and `done` happens to be the only one
 * since `cancelled` was folded into it.
 */
export const CLOSED: readonly string[] = ['done']

/**
 * How a status reads as a column heading.
 *
 * A heading is a label and the stored value is a key; `validation` is the
 * file's word and Validation is the reader's. A status this view does not
 * know is returned untouched rather than title-cased into something that
 * looks official — it is a finding, and it should look like one.
 * @param status - the stored value.
 * @returns the heading to draw.
 */
export function statusLabel(status: string): string {
  if (!BOARD_STATUSES.includes(status)) return status
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/**
 * Where a campaign sorts: by how much it wants attention, then by name.
 *
 * Executing above validation above backlog above idea — what needs you, above
 * what is waiting. A status the board does not know sorts last rather than
 * first: it is a finding, and a finding should not lead the board.
 * @param status - the campaign's status.
 * @returns its rank, lower first.
 */
function rankOf(status: string): number {
  const order = ['executing', 'validation', 'backlog', 'idea', 'done']
  const at = order.indexOf(status)
  return at === -1 ? order.length : at
}

/**
 * The campaigns the board does not draw, so they can be got back.
 *
 * A closed campaign is hidden, not deleted, and this is what the `N hidden`
 * control lists. Kept beside `groupBoard` so the two cannot disagree about
 * which campaigns are which.
 * @param campaigns - the board's campaigns, as read.
 * @returns those the board leaves off, in the order they were read.
 */
export function closedCampaigns(campaigns: EntityView[]): EntityView[] {
  return campaigns.filter((campaign) => CLOSED.includes(campaign.status))
}
```

In `groupBoard`, filter and sort before mapping:

```ts
export function groupBoard(campaigns: EntityView[]): GroupView[] {
  const shown = campaigns
    .filter((campaign) => !CLOSED.includes(campaign.status))
    .slice()
    .sort((left, right) => rankOf(left.status) - rankOf(right.status) || left.name.localeCompare(right.name))
  return shown.map((campaign) => {
```

with the rest of the body unchanged. Extend `groupBoard`'s JSDoc to say a closed campaign is left off and why, and that missions are not sorted — a mission's order is the order its folders were read in, which is stable and is the order someone gave them.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/renderer/pane/board-rows.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the closed rule is load-bearing**

Remove the `.filter(...)` from `groupBoard`. Re-run. Expected: "leaves a done campaign off the board" fails. Restore.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.pane.json --noEmit`

```bash
git add src/renderer/pane/board-rows.ts src/renderer/pane/board-rows.spec.ts
git commit -m "feat(board): sort campaigns by what needs you, and close the finished ones"
```

---

### Task 3: Hidden campaigns, remembered

The one part that is not renderer-only. Folding is a posture and dies with the session; hiding is a decision and has to survive a restart, or it is just a slower fold.

**Files:**
- Modify: `src/main/config.ts`, `src/main/config.spec.ts`, `src/main/index.ts`, `src/main/index.spec.ts`, `src/preload/pane.ts`, `src/renderer/pane/bridge.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // config.ts: DesktopConfig gains
  hiddenCampaigns?: Record<string, string[]>   // project path → folder paths
  ```
  IPC: `tasks:hidden` (invoke, `()` → `string[]`), `tasks:set-hidden` (invoke, `(folderPaths: string[])` → `void`).
  Bridge: `readHidden(): Promise<string[]>`, `writeHidden(folderPaths: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing test**

In `src/main/config.spec.ts`, following that file's existing shape:

```ts
describe('hidden campaigns', () => {
  // reason: hiding is a decision, and one that vanished on restart would be a
  // slower fold. Keyed by project because the same folder path names
  // different work in a different repository.
  it('keeps a hidden list per project', () => {
    const stored = parseConfig({ ...MINIMAL, hiddenCampaigns: { '/p/one': ['campaigns/q3'] } })
    expect(stored.configured && stored.config.hiddenCampaigns).toEqual({ '/p/one': ['campaigns/q3'] })
  })

  // reason: every file written before this feature has no such key, and a
  // config that refused one would lock the user out of their own settings.
  it('reads a config that predates it', () => {
    const stored = parseConfig(MINIMAL)
    expect(stored.configured).toBe(true)
  })

  it('drops a malformed entry rather than refusing the whole config', () => {
    const stored = parseConfig({ ...MINIMAL, hiddenCampaigns: { '/p/one': 'not-a-list', '/p/two': ['campaigns/x'] } })
    expect(stored.configured && stored.config.hiddenCampaigns).toEqual({ '/p/two': ['campaigns/x'] })
  })
})
```

Use whatever the file already calls its minimal valid config; if there is no such constant, build one the way its existing tests do.

In `src/main/index.spec.ts`, inside the describe that holds the board channel tests:

```ts
    it('answers with nothing hidden for a project that has hidden nothing', async () => {
      await bootInRepo()
      expect(await fake.sendIpc('tasks:hidden')).toEqual([])
    })

    it('remembers what was hidden, and gives it back', async () => {
      await bootInRepo()
      await fake.sendIpc('tasks:set-hidden', ['campaigns/q3'])
      expect(await fake.sendIpc('tasks:hidden')).toEqual(['campaigns/q3'])
      expect(writeConfigMock).toHaveBeenCalled()
    })

    // reason: the same folder path names different work in another
    // repository, so one project's hidden list must never reach another's.
    it('keeps one project’s hidden list out of another’s', async () => {
      await bootInRepo()
      await fake.sendIpc('tasks:set-hidden', ['campaigns/q3'])
      const written = writeConfigMock.mock.calls.at(-1)?.[1] as { hiddenCampaigns: Record<string, string[]> }
      expect(Object.keys(written.hiddenCampaigns)).toEqual([repo])
    })

    it('refuses to hide anything when no project is open', async () => {
      await bootReady()
      expect(await fake.sendIpc('tasks:hidden')).toEqual([])
    })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/config.spec.ts src/main/index.spec.ts`
Expected: FAIL — the key and the channels do not exist.

- [ ] **Step 3: Implement the config**

In `src/main/config.ts`, add to `DesktopConfig`:

```ts
  /**
   * Which campaigns are hidden from the board, per project.
   *
   * Keyed by the project's own path because a folder path like
   * `campaigns/q3` names different work in a different repository, and one
   * project's decision must not reach another's board.
   *
   * Optional because every file written before the board existed has no such
   * key, and a config that refused one would lock the user out of settings
   * over a preference about a panel.
   */
  hiddenCampaigns?: Record<string, string[]>
```

and in `parseConfig`, read it defensively — an entry whose value is not an array of strings is dropped, and the rest of the map survives:

```ts
/**
 * The hidden-campaign map, with anything malformed dropped.
 *
 * A hand-edited config, or one written by an older build, can hold anything
 * here. One bad entry loses one project's preference; refusing the file would
 * lose every setting the user has.
 * @param raw - the value found under `hiddenCampaigns`.
 * @returns the entries that are a project path mapped to a list of paths.
 */
function parseHiddenCampaigns(raw: unknown): Record<string, string[]> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string[]> = {}
  for (const [project, paths] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(paths)) continue
    out[project] = paths.filter((path): path is string => typeof path === 'string')
  }
  return Object.keys(out).length === 0 ? undefined : out
}
```

- [ ] **Step 4: Implement the channels**

In `src/main/index.ts`, beside the other board channels:

```ts
    // Hiding is a decision, so it is stored rather than held; folding is a
    // posture and stays in the view that did it.
    ipcMain.handle('tasks:hidden', () => {
      const project = currentProject?.path
      if (project === undefined) return []
      const stored = loadConfig(CONFIG_PATH)
      if (!stored.configured) return []
      return stored.config.hiddenCampaigns?.[project] ?? []
    })
    ipcMain.handle('tasks:set-hidden', (_event, folderPaths: string[]) => {
      const project = currentProject?.path
      if (project === undefined) return
      const stored = loadConfig(CONFIG_PATH)
      if (!stored.configured) return
      const kept = folderPaths.filter((path) => typeof path === 'string')
      // The whole list every time rather than an add and a remove: the view
      // holds the truth while it is open, and two channels that could
      // disagree about what is hidden is a state nobody can reason about.
      writeConfig(CONFIG_PATH, {
        ...stored.config,
        hiddenCampaigns: { ...stored.config.hiddenCampaigns, [project]: kept },
      })
    })
```

In `src/preload/pane.ts`:

```ts
  readHidden: () => ipcRenderer.invoke('tasks:hidden'),
  writeHidden: (folderPaths: string[]) => ipcRenderer.invoke('tasks:set-hidden', folderPaths),
```

and declare both in `src/renderer/pane/bridge.ts` as `readHidden(): Promise<string[]>` and `writeHidden(folderPaths: string[]): Promise<void>`.

- [ ] **Step 5: Run the tests and both typechecks**

Run: `npx vitest run src/main/config.spec.ts src/main/index.spec.ts`, then `npm test`, then both typechecks.
Expected: all pass.

- [ ] **Step 6: Prove the per-project keying is load-bearing**

Change the write to `hiddenCampaigns: { [project]: kept }` — dropping the spread, so one project's write erases every other's. Re-run `npx vitest run src/main/index.spec.ts`. Expected: nothing fails, because no test has two projects. **Write that test now**, hide something in one project, switch, hide something in the other, and assert both survive. Then restore the spread and confirm it passes.

- [ ] **Step 7: Commit**

```bash
git add src/main/config.ts src/main/config.spec.ts src/main/index.ts src/main/index.spec.ts src/preload/pane.ts src/renderer/pane/bridge.ts
git commit -m "feat(board): a hidden campaign is a decision, so it is remembered"
```

---

### Task 4: Folding, hiding and the way back

> **A note on this task.** Its module is specified as a behaviour contract
> plus a complete test file, not code to transcribe — it is a few hundred
> lines of DOM and CSS, and writing it out would not add precision the tests
> do not already carry. **The spec file is the contract**: every class name
> and piece of copy is in the test or in the bullets, and
> `src/renderer/pane/git.ts` is the shape to follow. Dispatch this one on a
> stronger model.


**Files:**
- Modify: `src/renderer/pane/board.ts`, `src/renderer/pane/board.spec.ts`

**Interfaces:**
- Consumes: `BOARD_STATUSES`, `statusLabel`, `closedCampaigns`, `groupBoard`, `chipOf` from `./board-rows.ts`; `readHidden`, `writeHidden` from the bridge.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/pane/board.spec.ts`, following the harness already in that file:

```ts
describe('folding', () => {
  it('folds a mission when its header is pressed, and keeps its columns off', async () => {
    await load(bridge(oneMission()))
    expect(document.querySelector('.board-columns')).not.toBeNull()
    document.querySelector<HTMLElement>('.board-lane-toggle')?.click()
    expect(document.querySelector('.board-lane-folded')).not.toBeNull()
  })

  // reason: a folded lane that said nothing would be a row of chrome. What it
  // holds is the reason you can leave it folded.
  it('says what a folded mission holds', async () => {
    await load(bridge(oneMission({ taskStatus: 'done' })))
    document.querySelector<HTMLElement>('.board-lane-toggle')?.click()
    expect(document.querySelector('.board-lane-summary')?.textContent).toContain('1')
  })

  it('folds a campaign, taking its lanes with it', async () => {
    await load(bridge(oneMission()))
    document.querySelector<HTMLElement>('.board-group-toggle')?.click()
    expect(document.querySelector('.board-group-folded')).not.toBeNull()
  })

  // reason: the + adds to the lane it sits on. If pressing it folded that
  // lane, every create would end by hiding what was just created.
  it('does not fold the lane when the plus is pressed', async () => {
    await load(bridge(oneMission()))
    document.querySelector<HTMLElement>('.board-lane-add')?.click()
    expect(document.querySelector('.board-lane-folded')).toBeNull()
  })

  // reason: folding is a posture, not a decision — it survives the redraw an
  // agent's write causes, and dies with the session.
  it('keeps a fold across a refresh', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-lane-toggle')?.click()
    stub.fire()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-lane-folded')).not.toBeNull()
  })
})

describe('hiding', () => {
  it('takes a campaign off the board and tells main', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-group-hide')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-group')).toBeNull()
    expect(stub.calls).toContainEqual(['hidden', ['campaigns/q3']])
  })

  // reason: nothing may disappear without somewhere to look for it — which is
  // also what makes hiding a done campaign automatically acceptable.
  it('counts what is hidden, however it got that way', async () => {
    const stub = bridge(twoCampaigns({ secondStatus: 'done' }))
    await load(stub)
    expect(document.querySelector('.board-hidden-count')?.textContent).toContain('1')
  })

  it('brings one back when it is chosen from the list', async () => {
    const stub = bridge(oneMission({ hidden: ['campaigns/q3'] }))
    await load(stub)
    expect(document.querySelector('.board-group')).toBeNull()
    document.querySelector<HTMLElement>('.board-hidden-count')?.click()
    document.querySelector<HTMLElement>('.board-hidden-item')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-group')).not.toBeNull()
  })

  // reason: a done campaign is hidden by the rule, not by a decision, so
  // un-hiding it must not write a decision that outlives the reason.
  it('does not persist an un-hide of a campaign that closed itself', async () => {
    const stub = bridge(twoCampaigns({ secondStatus: 'done' }))
    await load(stub)
    document.querySelector<HTMLElement>('.board-hidden-count')?.click()
    document.querySelector<HTMLElement>('.board-hidden-item')?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(stub.calls.filter((call) => call[0] === 'hidden')).toEqual([])
  })
})

describe('reveal through a fold', () => {
  // reason: a reveal that scrolled to something invisible is the same silence
  // as no reveal at all — which is the bug this feature has already had twice.
  it('unfolds a folded mission to reveal a card inside it', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-lane-toggle')?.click()
    stub.reveal('campaigns/q3/missions/m1/tasks/t1')
    expect(document.querySelector('.board-lane-folded')).toBeNull()
    expect(document.querySelector('.board-card-revealed')).not.toBeNull()
  })

  it('unfolds a folded campaign to reveal a lane inside it', async () => {
    const stub = bridge(oneMission())
    await load(stub)
    document.querySelector<HTMLElement>('.board-group-toggle')?.click()
    stub.reveal('campaigns/q3/missions/m1')
    expect(document.querySelector('.board-group-folded')).toBeNull()
    expect(document.querySelector('.board-lane-revealed')).not.toBeNull()
  })

  it('unhides a hidden campaign to reveal something inside it', async () => {
    const stub = bridge(oneMission({ hidden: ['campaigns/q3'] }))
    await load(stub)
    stub.reveal('campaigns/q3/missions/m1')
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(document.querySelector('.board-lane-revealed')).not.toBeNull()
  })
})
```

Extend the file's `bridge` helper to answer `readHidden` from a `hidden` option and to record `writeHidden` as `['hidden', paths]` in `calls`; add a `twoCampaigns` fixture beside `oneMission`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/renderer/pane/board.spec.ts`
Expected: FAIL — none of these controls exist.

- [ ] **Step 3: Implement**

In `src/renderer/pane/board.ts`:

- Two module-level `Set<string>`s, `foldedLanes` and `foldedGroups`, keyed by folder path, and a `hidden: string[]` read once on load through `window.pane.readHidden()`. All three are cleared when `latest.project` changes, beside the existing `refusal` and `revealed` reset.
- A lane's header becomes `<button class="board-lane-toggle">` carrying the twisty and the title. **The status pill and the `+` are siblings of it, never inside it** — a button within a button is invalid markup a browser may take apart, which this panel has already been restructured once to fix. A folded lane gets `board-lane-folded` on the section, its `.board-columns` is not appended, and a `.board-lane-summary` says how many cards it holds and how many are done.
- A campaign heading gains the same treatment: `.board-group-toggle`, `board-group-folded`, and a `.board-group-hide` button that appends the campaign's path to `hidden`, calls `window.pane.writeHidden(hidden)`, and redraws.
- Above the groups, `.board-hidden-count` when anything is hidden, reading `N hidden`. Pressing it reveals `.board-hidden-item` buttons — one per hidden campaign, from `hidden` and from `closedCampaigns(latest.campaigns)` together, deduplicated. Pressing one removes it from `hidden` and redraws; **it only calls `writeHidden` when the campaign was in `hidden`**, because un-hiding a campaign that closed itself is not a decision worth storing.
- `onReveal` clears the fold of whatever contains the revealed path, and removes it from `hidden`, before drawing — `campaigns/q3/missions/m1/tasks/t1` unfolds both `campaigns/q3` and `campaigns/q3/missions/m1`, because a prefix of a board path is its container.

- [ ] **Step 4: Run the tests, the suite and both typechecks**

Run: `npx vitest run src/renderer/pane/board.spec.ts`, then `npm test`, then both typechecks, then `npm run build`.
Expected: all pass.

- [ ] **Step 5: Prove the unfold-on-reveal is load-bearing**

Remove the unfold from `onReveal`. Re-run. Expected: all three reveal-through-a-fold tests fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/pane/board.ts src/renderer/pane/board.spec.ts
git commit -m "feat(board): campaigns and missions fold, and a hidden one has a way back"
```

---

### Task 5: The design pass

> **A note on this task.** Its module is specified as a behaviour contract
> plus a complete test file, not code to transcribe — it is a few hundred
> lines of DOM and CSS, and writing it out would not add precision the tests
> do not already carry. **The spec file is the contract**: every class name
> and piece of copy is in the test or in the bullets, and
> `src/renderer/pane/git.ts` is the shape to follow. Dispatch this one on a
> stronger model.


The board is currently unreadable: 140px columns truncate every card's name, the delete sits on top of the text, and the column tint is only as tall as its header so cards spill out of it. This is the pass that fixes it, and it covers the tree so the two views read as one feature.

**Files:**
- Modify: `src/renderer/pane.css`, `src/renderer/pane/board.ts`, `src/renderer/pane/tasks-tree.ts`, `src/renderer/pane/board.spec.ts`

**Interfaces:**
- Consumes: `statusLabel` from `./board-rows.ts`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
describe('the board’s shape', () => {
  // reason: a card that cannot show what it is called is not a card, and a
  // 140px column cannot. The columns grow with the pane and the board scrolls.
  it('does not pin a column to a fixed width', () => {
    const css = readFileSync('src/renderer/pane.css', 'utf8')
    const rule = css.slice(css.indexOf('.board-column {'), css.indexOf('}', css.indexOf('.board-column {')))
    expect(rule).not.toMatch(/width:\s*\d+px/)
  })

  it('renders a column heading as a label rather than a stored key', async () => {
    await load(bridge(oneMission()))
    const headings = [...document.querySelectorAll('.board-column-title')].map((node) => node.textContent)
    expect(headings[0]).toContain('Idea')
    expect(headings.some((text) => text?.includes('validation'))).toBe(false)
  })

  // reason: the delete's own comment says it is hidden until asked for. It
  // was not — it sat on the card's text, in red, reading as an error badge.
  it('keeps the delete out of the way until the card is hovered or focused', () => {
    const css = readFileSync('src/renderer/pane.css', 'utf8')
    const rule = css.slice(css.indexOf('.board-card-delete {'), css.indexOf('}', css.indexOf('.board-card-delete {')))
    expect(rule).toMatch(/opacity:\s*0/)
    expect(css).toMatch(/\.board-card-wrap:(hover|focus-within)[^{]*\{[^}]*opacity:\s*1/)
  })
})
```

Add `import { readFileSync } from 'node:fs'` at the top of the spec, following the pattern the modal's stylesheet test already set in this file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/pane/board.spec.ts`
Expected: FAIL — the column is 140px wide, the headings are stored keys, and the delete has no opacity rule.

- [ ] **Step 3: The board's rules**

In `src/renderer/pane.css`, rewrite the board's rules. What must be true, with the reason each one exists in a comment:

- **`.board-columns`** is a grid: `grid-auto-flow: column; grid-auto-columns: minmax(190px, 1fr); gap: 1px`, on a background that shows through as hairlines between columns. Horizontal scroll on the group, not the lane — every lane must scroll together or the columns drift out of alignment, which no swimlane board does.
- **`.board-column`** has no fixed width and no `min-height` of its own; it fills the lane's height so cards sit *in* something. An empty one takes the page's background rather than the surface's, so it is present without being louder than the work.
- **`.board-column-title`** is small, uppercase, tertiary, with a count beside it.
- **`.board-card`** is a block, not a wrapping flex row. `.board-card-name` clamps to two lines and then ellipses. The metadata — the bug tag, the criteria count, the validation chip — sits on its own line beneath, quieter.
- **`.board-card-delete`** is `opacity: 0`, rising to 1 on `.board-card-wrap:hover` and on `:focus-within`, so a keyboard user can reach it.
- **`.board-group`** indents its lanes by 16px with a 2px rule and 10px of padding down the left, so a folded mission and a folded campaign — otherwise the same shape — cannot read as siblings, and an open campaign has a visible extent.
- Colour comes from the harness's own tokens, as every other surface here does. Only `executing` and `done` earn a status colour; the rest are neutral. Read the existing `.git-row` and status rules and follow their tokens.

- [ ] **Step 4: The tree's rules, and the labels**

The tree's `.tree-row`, `.tree-twisty`, `.tree-status`, `.tree-status-unknown` and `.tree-count` were styled in an earlier pass; check them against the board's new tokens and make the two agree. In `src/renderer/pane/tasks-tree.ts` and `src/renderer/pane/board.ts`, draw every status through `statusLabel`.

- [ ] **Step 5: Run everything**

Run: `npx vitest run src/renderer/pane/board.spec.ts`, then `npm test`, then both typechecks, then `npm run build`.
Expected: all pass.

- [ ] **Step 6: Look at it**

Build the app and open it, or render the panel's markup against the real `pane.css` in a browser. **A design pass signed off without being seen is not a design pass** — this one exists because the last one was. Report what you saw, at a narrow pane width as well as a wide one.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/pane.css src/renderer/pane/board.ts src/renderer/pane/tasks-tree.ts src/renderer/pane/board.spec.ts
git commit -m "feat(board): cards that show their names, columns that look like columns"
```

---

### Task 6: The specs and the README

**Files:**
- Modify: `docs/notes/task-board.md`, `docs/notes/task-board-views.md`, `README.md`

- [ ] **Step 1: Check both specs against what was built**

Both were written before any of this existed and have each been corrected once already. Read every section against the code — `board-rows.ts`, `board.ts`, `tasks-tree.ts`, the channels in `index.ts` — and correct any sentence that is now untrue. **Verify each new sentence against the source and cite the line you checked**; a correction that replaces one false sentence with another is worse than the original, because it now carries the authority of having been checked.

Places a spec drifts quietly: what a card shows, what a folded thing says, what the `+` creates, the modal's dismissal rule, what the tree's rows show, and the "Deliberately not in this" list.

- [ ] **Step 2: The README**

Update the board paragraph for the five statuses and the folding, in the README's own voice:

```markdown
Work moves left to right through five columns — idea, backlog, executing,
validation, done — and there is no failed: work that fails goes back, and what
went wrong is already in a bug or a test's verdict. Campaigns and missions
both fold, a campaign can be hidden, and a finished one hides itself.
```

- [ ] **Step 3: Commit**

```bash
git add docs/notes/task-board.md docs/notes/task-board-views.md README.md
git commit -m "docs(board): five statuses, folding, and what the views actually do"
```

---

## Manual verification

Checked by hand once, in a packaged build (`npm run build && npx electron-builder --dir -c.mac.identity=null`; quit any running copy from the tray first):

1. A board carrying old statuses — `draft`, `cancelled` — reports findings and puts those cards in the first column. Nothing is rewritten.
2. Ask the agent to create a task. It lands in **Idea**.
3. Drag a card across all five columns. The mission's status never moves.
4. Fold a mission, then a campaign. Both say what they hold. Restart: both are open again.
5. Hide a campaign. Restart: still hidden. Bring it back from `N hidden`.
6. Set a campaign to `done`. It leaves the board and appears in `N hidden`, and the tree still has it.
7. Click a tree row inside a folded and hidden campaign. It unhides, unfolds, and the card is marked.
8. Narrow the pane until the columns scroll. Every lane scrolls together.
