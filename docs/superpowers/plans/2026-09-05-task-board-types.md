# Task Board: Three Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the board's store from four flat kinds into three types — a workitem with a subtype, a bug, and a test — with tests living in their own container of nested suites, linked to the workitems they prove.

**Architecture:** The four kinds `campaign | mission | task | bug` become the three types `workitem | bug | test`, where a workitem carries `subtype: campaign | mission | task`. Paths and schemas still care about the finer granularity, so a third type alias — the **level** — names it: the subtype for a workitem, the type itself for a bug or a test. The file on disk is named for the *type*; the directory it sits in says the *level*. Tests are read by a separate recursive walk, and a workitem's `validated_by` list carries the verdict for each test that proves it.

**Tech Stack:** TypeScript (CommonJS main process), `js-yaml@^4.3.1`, `zod`, Vitest.

**Spec:** `docs/notes/task-board.md`

## Global Constraints

- **No formatter is configured.** Do NOT run `prettier`, `eslint --fix`, or any other formatter. Match the surrounding style by hand: 2-space indent, **no semicolons**, **single quotes**, ~120-column lines.
- **Stage only the files your task names.** Never `git add -A`, `git add .`, or `git commit -a`. The repo root holds untracked `index.js` and `tree-menu.js` belonging to the user, which must never be committed.
- **Every exported symbol carries a JSDoc block** with `@param` and `@returns`, saying *why*, not *what*, in the voice of the surrounding code.
- Tests are colocated: `src/main/board/entity-schema.spec.ts` beside `entity-schema.ts`.
- **Nothing on disk needs migrating.** No board has ever been written by a released build, so there is no compatibility path to keep and no reader for the old shape. Do not write one.
- **A status is never inferred.** No write to a child may change its parent's status. There is no rollup and no cascade.
- The status set is exactly `draft`, `executing`, `awaitingApproval`, `done`, `failed`, `cancelled`, and applies to **workitems and bugs only**. A test has no status.
- A link's result set is exactly `pass`, `fail`, `not_run`.
- **Reading never writes.** A malformed file yields a finding and an absent entity, never a repair.
- **Delete moves to `.dsh/tasks/.trash/`.** Nothing in this plan removes a board folder.
- The run history is capped at **50** entries, oldest dropped.
- Commands: `npm test`, `npx vitest run <file>`, `npx tsc -p tsconfig.json --noEmit`. The typecheck must be clean before every commit.

---

## File Structure

All under `src/main/board/`, all **modified** — nothing new is created:

| File | What changes |
| --- | --- |
| `entity-schema.ts` | Types, subtype, levels, per-level key sets, `validated_by`, `runs`, test fields |
| `board-paths.ts` | `folderFor` by level, the file name from the type, the `tests/` root |
| `board-read.ts` | Level-aware walk, the recursive tests walk, four new findings |
| `board-write.ts` | Create by type and subtype; link, unlink, record a run |

Plus `src/main/view-mcp.ts` for the tools.

---

### Task 1: Three types, and the level that paths and schemas care about

**Files:**
- Modify: `src/main/board/entity-schema.ts`
- Test: `src/main/board/entity-schema.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type EntityType = 'workitem' | 'bug' | 'test'
  export type WorkitemSubtype = 'campaign' | 'mission' | 'task'
  export type EntityLevel = WorkitemSubtype | 'bug' | 'test'
  export const WORKITEM_SUBTYPES: readonly WorkitemSubtype[]
  export const ENTITY_LEVELS: readonly EntityLevel[]
  export function typeOf(level: EntityLevel): EntityType
  export const LEVEL_KEYS: Record<EntityLevel, readonly string[]>
  export function loadEntity(text: string): EntityFields   // unchanged signature
  export function dumpEntity(level: EntityLevel, f: EntityFields): string
  ```
  `EntityKind` and `KIND_KEYS` are **removed**; every consumer moves to `EntityLevel` and `LEVEL_KEYS` in a later task.

- [ ] **Step 1: Write the failing test**

Replace the `describe('the status set', …)` block in `src/main/board/entity-schema.spec.ts` and append these. Change the file's import line to `import { dumpEntity, ENTITY_STATUSES, loadEntity, typeOf, WORKITEM_SUBTYPES } from './entity-schema'`.

```ts
describe('the vocabularies', () => {
  it('has exactly the six statuses the board draws', () => {
    expect([...ENTITY_STATUSES]).toEqual(['draft', 'executing', 'awaitingApproval', 'done', 'failed', 'cancelled'])
  })

  it('has exactly the three workitem subtypes', () => {
    expect([...WORKITEM_SUBTYPES]).toEqual(['campaign', 'mission', 'task'])
  })
})

describe('typeOf', () => {
  // reason: the file on disk is named for the TYPE, while the directory it
  // sits in says the LEVEL. This is the one function that crosses between
  // them, so every path and every filename in the store depends on it.
  it('calls every workitem subtype a workitem', () => {
    expect(typeOf('campaign')).toBe('workitem')
    expect(typeOf('mission')).toBe('workitem')
    expect(typeOf('task')).toBe('workitem')
  })

  it('leaves a bug and a test as themselves', () => {
    expect(typeOf('bug')).toBe('bug')
    expect(typeOf('test')).toBe('test')
  })
})

describe('subtype', () => {
  it('reads a workitem subtype off the file', () => {
    expect(loadEntity('name: Q3\nsubtype: campaign\n').subtype).toBe('campaign')
  })

  // reason: every workitem file says what it is, so a file read on its own —
  // by a person, by a tool that did not walk the tree — is self-describing.
  it('writes the subtype for every workitem level', () => {
    for (const level of ['campaign', 'mission', 'task'] as const) {
      expect(dumpEntity(level, loadEntity('name: X\n'))).toContain(`subtype: ${level}`)
    }
  })

  it('writes no subtype for a bug or a test', () => {
    expect(dumpEntity('bug', loadEntity('name: B\n'))).not.toContain('subtype')
    expect(dumpEntity('test', loadEntity('name: T\n'))).not.toContain('subtype')
  })

  // reason: the level the caller names wins over whatever the file said. The
  // caller got its level from the path, and the path is what the reader walks.
  it('rewrites a subtype that disagrees with the level it is dumped at', () => {
    const fields = loadEntity('name: M\nsubtype: campaign\n')
    expect(dumpEntity('mission', fields)).toContain('subtype: mission')
  })
})

describe('what each level writes', () => {
  it('gives a campaign a target and documents, and a task neither', () => {
    const campaign = dumpEntity('campaign', loadEntity('name: C\n'))
    expect(campaign).toContain('target')
    expect(campaign).toContain('documents')
    const task = dumpEntity('task', loadEntity('name: T\n'))
    expect(task).not.toContain('target')
    expect(task).not.toContain('documents')
  })

  it('gives a bug its reproduction and no acceptance criteria', () => {
    const bug = dumpEntity('bug', loadEntity('name: B\n'))
    expect(bug).toContain('steps_to_reproduce')
    expect(bug).toContain('severity')
    expect(bug).not.toContain('acceptance_criteria')
  })

  // reason: a test is not work in flight, so it has nothing to move through.
  // A status on it would put it in a column it does not belong in.
  it('gives a test steps and expected, and no status', () => {
    const test = dumpEntity('test', loadEntity('name: T\nsteps: click it\nexpected: it works\n'))
    expect(test).toContain('steps: click it')
    expect(test).toContain('expected: it works')
    expect(test).not.toContain('status')
    expect(test).not.toContain('acceptance_criteria')
  })

  it('still gives a workitem and a bug a status, defaulting to draft', () => {
    expect(dumpEntity('task', loadEntity('name: T\n'))).toContain('status: draft')
    expect(dumpEntity('bug', loadEntity('name: B\n'))).toContain('status: draft')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/board/entity-schema.spec.ts`
Expected: FAIL — `typeOf` and `WORKITEM_SUBTYPES` do not exist, and `dumpEntity` does not take a level.

- [ ] **Step 3: Implement**

In `src/main/board/entity-schema.ts`, replace the `EntityKind` declaration with:

```ts
/**
 * What an entity is, at the granularity the file name uses.
 *
 * Three rather than five, because a campaign, a mission and a task differ in
 * altitude and not in nature: they carry the same fields, move through the
 * same statuses, and every tool that acts on one acts on all three. A bug
 * carries a reproduction and a test carries what it proves, so those are
 * genuinely different things and earn files of their own.
 */
export type EntityType = 'workitem' | 'bug' | 'test'

/** Which altitude a workitem sits at. */
export type WorkitemSubtype = 'campaign' | 'mission' | 'task'

/** The three subtypes, in the order they nest. */
export const WORKITEM_SUBTYPES: readonly WorkitemSubtype[] = ['campaign', 'mission', 'task']

/**
 * What an entity is, at the granularity paths and schemas care about.
 *
 * The type alone is too coarse — a campaign and a task are both workitems but
 * live in different directories and write different keys — and the subtype
 * alone does not cover bugs and tests. The level is the union that every
 * path and every key set is actually indexed by.
 */
export type EntityLevel = WorkitemSubtype | 'bug' | 'test'

/** Every level, so a caller can iterate them without rebuilding the union. */
export const ENTITY_LEVELS: readonly EntityLevel[] = [...WORKITEM_SUBTYPES, 'bug', 'test']

/**
 * The type a level belongs to, which is the file it is stored in.
 *
 * The one function that crosses between the two vocabularies: the directory
 * an entity sits in says its level, and the file inside is named for its
 * type. Every path and every filename in the store goes through here.
 * @param level - the level.
 * @returns the type whose `<type>.yaml` holds it.
 */
export function typeOf(level: EntityLevel): EntityType {
  return level === 'bug' || level === 'test' ? level : 'workitem'
}
```

Replace `KIND_KEYS` with:

```ts
/**
 * Which top-level keys each level emits. A known key outside its level's list
 * is misplaced — carried through `extra` rather than destroyed, and reported.
 */
export const LEVEL_KEYS: Record<EntityLevel, readonly string[]> = {
  campaign: ['name', 'subtype', 'status', 'target', 'description', 'acceptance_criteria', 'validated_by', 'documents', 'notes'],
  mission: ['name', 'subtype', 'status', 'description', 'acceptance_criteria', 'validated_by', 'documents', 'notes'],
  task: ['name', 'subtype', 'status', 'role', 'description', 'acceptance_criteria', 'validated_by', 'notes'],
  bug: [
    'name',
    'status',
    'severity',
    'description',
    'steps_to_reproduce',
    'expected',
    'actual',
    'rca',
    'environment',
    'notes',
  ],
  test: ['name', 'description', 'steps', 'expected', 'runs', 'notes'],
}
```

Add `'subtype'`, `'validated_by'`, `'steps'` and `'runs'` to `KNOWN_KEYS`.

On `EntityFields`, add above `status`:

```ts
  /** A workitem's altitude, as its own file records it. Absent on a bug or a test. */
  subtype?: string
  /** What a test says to do. */
  steps?: string
```

In `loadEntity`, add `subtype: optString(raw.subtype),` and `steps: optString(raw.steps),` beside the other `optString` reads.

Replace `dumpEntity` with:

```ts
export function dumpEntity(level: EntityLevel, f: EntityFields): string {
  const type = typeOf(level)
  const o: Record<string, unknown> = { name: f.name }
  // The level the caller named wins over whatever the file said, because the
  // caller got its level from the path and the path is what the reader walks.
  // A file that disagreed is reported by the reader, not silently kept.
  if (type === 'workitem') o.subtype = level
  // A test has no status: it is not work in flight, it is the instrument the
  // work is measured with, and a status would put it in a column it does not
  // belong in.
  if (type !== 'test') o.status = f.status ?? 'draft'
  if (level === 'campaign') o.target = f.target ?? ''
  if (level === 'task' && f.role) o.role = f.role
  if (type === 'bug') o.severity = f.severity ?? 'major'
  o.description = f.description ?? ''
  if (type === 'bug') {
    o.steps_to_reproduce = f.stepsToReproduce ?? ''
    o.expected = f.expected ?? ''
    o.actual = f.actual ?? ''
    o.rca = f.rca ?? ''
    o.environment = f.environment ?? ''
  } else if (type === 'test') {
    o.steps = f.steps ?? ''
    o.expected = f.expected ?? ''
  } else {
    // Spread the item's other keys back out — an agent may annotate a criterion
    // (evidence, who verified it) and a rewrite must not strip that.
    o.acceptance_criteria = f.acceptanceCriteria.map((c) => ({
      text: c.text,
      done: c.done,
      ...restOf(c, ['text', 'done']),
    }))
  }
  if (level === 'campaign' || level === 'mission') {
    o.documents = f.documents.map((d) => ({ label: d.label, target: d.target, ...restOf(d, ['label', 'target']) }))
  }
  // Free-form appended prose (decisions/rationale/sign-offs), for any level.
  if (f.notes && f.notes.trim()) o.notes = f.notes
  // Keys this schema does not model are re-emitted last, so a write never
  // destroys content it did not understand. The typed model always wins for a
  // key this LEVEL owns — including when it chose to omit one, which is how a
  // field gets cleared.
  for (const [k, v] of Object.entries(f.extra ?? {})) {
    if (k in o || LEVEL_KEYS[level].includes(k)) continue
    o[k] = v
  }
  return yamlDump(o, { lineWidth: -1, noRefs: true })
}
```

Update `dumpEntity`'s JSDoc to say `@param level` rather than `@param kind`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/entity-schema.spec.ts`
Expected: PASS. Other files will not compile yet — that is expected and later tasks fix them.

- [ ] **Step 5: Prove the level-wins rule is load-bearing**

Change `if (type === 'workitem') o.subtype = level` to `o.subtype = f.subtype ?? level`. Re-run. Expected: "rewrites a subtype that disagrees with the level it is dumped at" fails. Restore.

- [ ] **Step 6: Commit**

`npx tsc -p tsconfig.json --noEmit` will still report errors in the three files that consume `EntityKind`; that is expected at this point in the plan. Commit anyway so the schema change is its own reviewable step.

```bash
git add src/main/board/entity-schema.ts src/main/board/entity-schema.spec.ts
git commit -m "feat(board): three types, and the level paths and schemas index by"
```

---

### Task 2: The link that carries a verdict, and the runs that show flakiness

**Files:**
- Modify: `src/main/board/entity-schema.ts`
- Test: `src/main/board/entity-schema.spec.ts`

**Interfaces:**
- Consumes: `EntityLevel`, `LEVEL_KEYS`, `typeOf` from Task 1.
- Produces:
  ```ts
  export type LinkResult = 'pass' | 'fail' | 'not_run'
  export const LINK_RESULTS: readonly LinkResult[]
  export interface TestLink { test: string; result: string; comment: string; bug?: string; [extra: string]: unknown }
  export interface TestRun { at: string; workitem: string; result: string; [extra: string]: unknown }
  export const RUN_HISTORY: number   // 50
  ```
  `EntityFields` gains `validatedBy: TestLink[]` and `runs: TestRun[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/board/entity-schema.spec.ts`, and add `LINK_RESULTS`, `RUN_HISTORY` to the file's import from `./entity-schema`.

```ts
describe('validated_by', () => {
  it('has exactly the three results a verdict can be', () => {
    expect([...LINK_RESULTS]).toEqual(['pass', 'fail', 'not_run'])
  })

  it('reads a link with its verdict, comment and bug', () => {
    const fields = loadEntity(
      'name: M\nvalidated_by:\n  - test: tests/auth/login\n    result: fail\n' +
        "    comment: returns 500\n    bug: campaigns/q3/bugs/login-500\n",
    )
    expect(fields.validatedBy).toEqual([
      { test: 'tests/auth/login', result: 'fail', comment: 'returns 500', bug: 'campaigns/q3/bugs/login-500' },
    ])
  })

  // reason: a link that names no test is not a link. Keeping it would put a
  // verdict on the board with nothing behind it.
  it('drops an entry that names no test', () => {
    expect(loadEntity('validated_by:\n  - result: pass\n').validatedBy).toEqual([])
  })

  // reason: an unrun link is the normal state of a test just added, and it
  // must read as unrun rather than as passing.
  it('defaults a missing result to not_run rather than to pass', () => {
    expect(loadEntity('validated_by:\n  - test: tests/a\n').validatedBy[0].result).toBe('not_run')
  })

  it('keeps an extra key on a link', () => {
    const fields = loadEntity('validated_by:\n  - test: tests/a\n    result: pass\n    run_by: ci\n')
    expect(fields.validatedBy[0].run_by).toBe('ci')
  })

  it('round-trips a link through a workitem dump', () => {
    const once = dumpEntity('mission', loadEntity('name: M\nvalidated_by:\n  - test: tests/a\n    result: pass\n'))
    expect(loadEntity(once).validatedBy[0]).toEqual({ test: 'tests/a', result: 'pass', comment: '' })
  })

  // reason: a bug and a test do not declare what proves them — a test IS the
  // proof, and giving it links would ask what proves the proof.
  it('writes no validated_by for a bug or a test', () => {
    const fields = loadEntity('name: X\nvalidated_by:\n  - test: tests/a\n')
    expect(dumpEntity('bug', fields)).not.toContain('validated_by')
    expect(dumpEntity('test', fields)).not.toContain('validated_by')
  })
})

describe('runs', () => {
  it('reads a run', () => {
    const fields = loadEntity(
      'name: T\nruns:\n  - at: 2026-09-05T09:12:00Z\n    workitem: campaigns/q3\n    result: pass\n',
    )
    expect(fields.runs).toEqual([{ at: '2026-09-05T09:12:00Z', workitem: 'campaigns/q3', result: 'pass' }])
  })

  it('drops a run with no timestamp, which cannot be ordered', () => {
    expect(loadEntity('runs:\n  - workitem: campaigns/q3\n    result: pass\n').runs).toEqual([])
  })

  // reason: flakiness is visible in a window; git holds everything older, and
  // an uncapped list makes every run a write to a file that only grows.
  it('keeps only the most recent RUN_HISTORY runs, dropping the oldest', () => {
    const many = Array.from(
      { length: RUN_HISTORY + 10 },
      (_, at) => `  - at: run-${String(at)}\n    workitem: w\n    result: pass\n`,
    ).join('')
    const written = dumpEntity('test', loadEntity(`name: T\nruns:\n${many}`))
    const kept = loadEntity(written).runs
    expect(kept).toHaveLength(RUN_HISTORY)
    expect(kept[0].at).toBe('run-10')
    expect(kept[RUN_HISTORY - 1].at).toBe(`run-${String(RUN_HISTORY + 9)}`)
  })

  it('writes no runs for a workitem or a bug', () => {
    const fields = loadEntity('name: X\nruns:\n  - at: t\n    workitem: w\n    result: pass\n')
    expect(dumpEntity('task', fields)).not.toContain('runs')
    expect(dumpEntity('bug', fields)).not.toContain('runs')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/board/entity-schema.spec.ts`
Expected: FAIL — `LINK_RESULTS` and `RUN_HISTORY` do not exist.

- [ ] **Step 3: Implement**

Add to `src/main/board/entity-schema.ts`, beside the other vocabularies:

```ts
/** What a test's verdict against one workitem can be. */
export type LinkResult = 'pass' | 'fail' | 'not_run'

/**
 * The three verdicts, fixed for the reason the statuses are.
 *
 * Kept apart from `ENTITY_STATUSES` deliberately: a status says how far work
 * has got, a result says whether a check held, and a vocabulary that mixed
 * them would answer two questions in one field.
 */
export const LINK_RESULTS: readonly LinkResult[] = ['pass', 'fail', 'not_run']

/**
 * How many runs a test keeps.
 *
 * Flakiness is visible in a window, git holds everything older, and an
 * uncapped list makes every run a write to a file that only grows. A number
 * in one place, so raising it is a decision rather than a refactor.
 */
export const RUN_HISTORY = 50
```

Add the two interfaces beside `AcceptanceCriterion`:

```ts
/**
 * One test, and what happened when it was last run against this workitem.
 *
 * The verdict lives on the link rather than on the test because a verdict is
 * about a pairing: one test can pass for the mission it was written for and
 * fail for the one that reused it, and both are true at once.
 */
export interface TestLink {
  /** The test's folder path within the board. */
  test: string
  /** One of `LINK_RESULTS`; anything else is a finding, not a repair. */
  result: string
  /** Why, in the reader's own words. Empty when there is nothing to say. */
  comment: string
  /** The defect a failure produced, when one was filed. */
  bug?: string
  /** Any other keys found on the entry, carried through untouched. */
  [extra: string]: unknown
}

/**
 * One execution of a test, as the test itself records it.
 *
 * A link's verdict answers "does this pass here, now". It cannot answer "does
 * this test give the same answer twice", and that is the difference between a
 * real failure and a flaky one.
 */
export interface TestRun {
  /** When it ran. Ordering is by position, so an unparseable date still sorts. */
  at: string
  /** The workitem it was run against. */
  workitem: string
  result: string
  /** Any other keys found on the entry, carried through untouched. */
  [extra: string]: unknown
}
```

Add the two parsers beside `parseCriteria`:

```ts
/**
 * Read a `validated_by` list.
 *
 * An entry with no `test` is dropped: a link that names nothing is not a
 * link, and keeping it would put a verdict on the board with nothing behind
 * it. A missing result reads as `not_run` rather than as `pass`, because an
 * unrun link is the normal state of a test just added and must not be
 * mistaken for a proof.
 * @param v - the raw value.
 * @returns the links, in order.
 */
function parseLinks(v: unknown): TestLink[] {
  if (!Array.isArray(v)) return []
  const out: TestLink[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object' || !('test' in item)) continue
    const test = asString((item as { test: unknown }).test)
    if (test === '') continue
    const bug = optString((item as { bug?: unknown }).bug)
    out.push({
      test,
      result: optString((item as { result?: unknown }).result) ?? 'not_run',
      comment: asString((item as { comment?: unknown }).comment),
      ...(bug === undefined ? {} : { bug }),
      ...restOf(item, ['test', 'result', 'comment', 'bug']),
    })
  }
  return out
}

/**
 * Read a `runs` list, keeping only the most recent `RUN_HISTORY`.
 *
 * A run with no `at` is dropped: it cannot be ordered, and an unordered run
 * in a history whose whole purpose is a sequence is noise.
 * @param v - the raw value.
 * @returns the runs, oldest first, capped.
 */
function parseRuns(v: unknown): TestRun[] {
  if (!Array.isArray(v)) return []
  const out: TestRun[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object' || !('at' in item)) continue
    const at = asString((item as { at: unknown }).at)
    if (at === '') continue
    out.push({
      at,
      workitem: asString((item as { workitem?: unknown }).workitem),
      result: optString((item as { result?: unknown }).result) ?? 'not_run',
      ...restOf(item, ['at', 'workitem', 'result']),
    })
  }
  return out.slice(-RUN_HISTORY)
}
```

On `EntityFields`, add:

```ts
  /** What proves this workitem, and what happened when it was last run. */
  validatedBy: TestLink[]
  /** A test's own execution history, capped at `RUN_HISTORY`. */
  runs: TestRun[]
```

In `loadEntity`, add `validatedBy: parseLinks(raw.validated_by),` and `runs: parseRuns(raw.runs),`.

In `dumpEntity`, inside the `else` branch that writes `acceptance_criteria`, add after it:

```ts
    o.validated_by = f.validatedBy.map((l) => ({
      test: l.test,
      result: l.result,
      comment: l.comment,
      ...(l.bug === undefined ? {} : { bug: l.bug }),
      ...restOf(l, ['test', 'result', 'comment', 'bug']),
    }))
```

and inside the `else if (type === 'test')` branch, after `o.expected`:

```ts
    o.runs = f.runs.slice(-RUN_HISTORY).map((r) => ({
      at: r.at,
      workitem: r.workitem,
      result: r.result,
      ...restOf(r, ['at', 'workitem', 'result']),
    }))
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/entity-schema.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the cap is load-bearing**

Change `return out.slice(-RUN_HISTORY)` to `return out`. Re-run. Expected: the cap test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/main/board/entity-schema.ts src/main/board/entity-schema.spec.ts
git commit -m "feat(board): a verdict on the link, and a run history on the test"
```

---

### Task 3: Where the three types live

**Files:**
- Modify: `src/main/board/board-paths.ts`
- Test: `src/main/board/board-paths.spec.ts`

**Interfaces:**
- Consumes: `EntityLevel`, `typeOf` from Task 1.
- Produces:
  ```ts
  export const TESTS_DIR: string                             // 'tests'
  export function folderFor(level: EntityLevel, parts: string[]): string
  export function fileFor(level: EntityLevel): string        // 'workitem.yaml' | 'bug.yaml' | 'test.yaml'
  ```
  `resolveInBoard`, `boardRoot`, `hasBoard`, `realpathAsFarAsExists`, `BOARD_DIR`, `TRASH_DIR` are unchanged.

- [ ] **Step 1: Write the failing test**

In `src/main/board/board-paths.spec.ts`, replace the `describe('folderFor', …)` block with:

```ts
describe('fileFor', () => {
  // reason: the file is named for the TYPE while the directory says the
  // LEVEL. A reader that looked for `mission.yaml` would find nothing.
  it('names the file after the type, not the level', () => {
    expect(fileFor('campaign')).toBe('workitem.yaml')
    expect(fileFor('mission')).toBe('workitem.yaml')
    expect(fileFor('task')).toBe('workitem.yaml')
    expect(fileFor('bug')).toBe('bug.yaml')
    expect(fileFor('test')).toBe('test.yaml')
  })
})

describe('folderFor', () => {
  it('nests a task under its mission and campaign', () => {
    expect(folderFor('task', ['q3', 'm1', 't1'])).toBe('campaigns/q3/missions/m1/tasks/t1')
  })

  it('nests a bug under a campaign when that is its only parent', () => {
    expect(folderFor('bug', ['q3', 'b1'])).toBe('campaigns/q3/bugs/b1')
  })

  it('nests a bug under a mission when it has one', () => {
    expect(folderFor('bug', ['q3', 'm1', 'b1'])).toBe('campaigns/q3/missions/m1/bugs/b1')
  })

  it('names a campaign and a mission', () => {
    expect(folderFor('campaign', ['q3'])).toBe('campaigns/q3')
    expect(folderFor('mission', ['q3', 'm1'])).toBe('campaigns/q3/missions/m1')
  })

  // reason: tests are their own container, and a suite is just a directory —
  // so a test's path is its suites and its slug, at any depth.
  it('puts a test under the tests root, at whatever depth its suites give it', () => {
    expect(folderFor('test', ['login'])).toBe('tests/login')
    expect(folderFor('test', ['auth', 'login'])).toBe('tests/auth/login')
    expect(folderFor('test', ['auth', 'oauth', 'google', 'callback'])).toBe('tests/auth/oauth/google/callback')
  })
})
```

Add `fileFor` to the file's import from `./board-paths`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/board/board-paths.spec.ts`
Expected: FAIL — `fileFor` does not exist.

- [ ] **Step 3: Implement**

In `src/main/board/board-paths.ts`, change the import to `import { typeOf, type EntityLevel } from './entity-schema'`, add the constant beside `TRASH_DIR`:

```ts
/** Where tests live, in suites of any depth. Never a child of a workitem. */
export const TESTS_DIR = 'tests'
```

Replace `folderFor`, and add `fileFor`:

```ts
/**
 * The file inside an entity's folder.
 *
 * Named for the type while the folder says the level, so a campaign, a
 * mission and a task all hold a `workitem.yaml`. A reader looking for
 * `mission.yaml` would find nothing, which is why this is a function and not
 * a string built at each call site.
 * @param level - the entity's level.
 * @returns the file name, including the extension.
 */
export function fileFor(level: EntityLevel): string {
  return `${typeOf(level)}.yaml`
}

/**
 * The folder path of an entity, from the slugs of it and its parents.
 *
 * The path is the entity's identity — there is no id file — so this is the
 * one place the shape of the tree is written down. A bug takes two parts when
 * a campaign owns it and three when a mission does, which is what "parented
 * by exactly one" looks like on disk. A test takes as many as its suites
 * give it, because a suite is a directory and nothing else.
 * @param level - which level the last slug names.
 * @param parts - for a workitem or a bug, the slugs from the campaign down;
 *   for a test, its suites followed by its own slug.
 * @returns the folder path, relative to the board root, with forward slashes.
 */
export function folderFor(level: EntityLevel, parts: string[]): string {
  if (level === 'test') return [TESTS_DIR, ...parts].join('/')
  const [campaign, ...rest] = parts
  if (level === 'campaign') return `campaigns/${campaign}`
  if (level === 'mission') return `campaigns/${campaign}/missions/${rest[0]}`
  if (level === 'task') return `campaigns/${campaign}/missions/${rest[0]}/tasks/${rest[1]}`
  // A bug under a campaign has one slug after it; one under a mission has two.
  if (rest.length === 1) return `campaigns/${campaign}/bugs/${rest[0]}`
  return `campaigns/${campaign}/missions/${rest[0]}/bugs/${rest[1]}`
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/board-paths.spec.ts`
Expected: PASS, all of them — the escape tests are untouched by this change and must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/main/board/board-paths.ts src/main/board/board-paths.spec.ts
git commit -m "feat(board): the file is named for the type, the folder for the level"
```

---

### Task 4: Reading three types, a tests tree, and four new findings

**Files:**
- Modify: `src/main/board/board-read.ts`
- Test: `src/main/board/board-read.spec.ts`

**Interfaces:**
- Consumes: `loadEntity`, `EntityFields`, `EntityLevel`, `ENTITY_STATUSES`, `LINK_RESULTS`, `typeOf`, `WORKITEM_SUBTYPES` from the schema; `boardRoot`, `hasBoard`, `fileFor`, `TESTS_DIR`, `TRASH_DIR` from paths.
- Produces:
  ```ts
  export interface Entity {
    level: EntityLevel
    folderPath: string
    slug: string
    name: string
    status: string           // '' for a test, which has none
    fields: EntityFields
    children: Entity[]
    progress: { done: number; total: number }
  }
  export interface Suite { path: string; slug: string; suites: Suite[]; tests: Entity[] }
  export interface Board { present: boolean; campaigns: Entity[]; tests: Suite; findings: Finding[] }
  export function readBoard(project: string): Board
  export function findEntity(board: Board, folderPath: string): Entity | undefined
  export function collectTests(suite: Suite, into: Set<string>): void
  ```
  `Entity.kind` is renamed to `Entity.level`. `Board` gains `tests`.

- [ ] **Step 1: Write the failing test**

In `src/main/board/board-read.spec.ts`, change the `put` helper's second argument from a kind to a **file name**, since the file no longer matches the level:

```ts
/**
 * Write one entity file into the board.
 * @param folderPath - the folder within the board.
 * @param file - the file name, `workitem.yaml`, `bug.yaml` or `test.yaml`.
 * @param body - the YAML body.
 */
function put(folderPath: string, file: string, body: string): void {
  const dir = join(project, '.dsh', 'tasks', folderPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), body)
}
```

Then update every existing call — `put('campaigns/q3', 'campaign', …)` becomes `put('campaigns/q3', 'workitem.yaml', …)`, `'mission'` and `'task'` likewise become `'workitem.yaml'`, and `'bug'` becomes `'bug.yaml'` — and change every `child.kind` assertion to `child.level`. Then append:

```ts
describe('reading the three types', () => {
  it('reads a campaign, a mission and a task as workitems at their own levels', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nsubtype: campaign\nstatus: executing\n')
    put('campaigns/q3/missions/m1', 'workitem.yaml', 'name: M1\nsubtype: mission\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'workitem.yaml', 'name: T1\nsubtype: task\nstatus: done\n')
    const board = readBoard(project)
    expect(board.campaigns[0].level).toBe('campaign')
    expect(board.campaigns[0].children[0].level).toBe('mission')
    expect(board.campaigns[0].children[0].children[0].level).toBe('task')
  })

  // reason: the path is what the reader walks, so it decides. The key is what
  // the file claims, and a claim that disagrees with where it sits is worth
  // saying out loud rather than quietly overruling.
  it('trusts the path over a subtype that disagrees, and reports the disagreement', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nsubtype: mission\n')
    const board = readBoard(project)
    expect(board.campaigns[0].level).toBe('campaign')
    expect(board.findings.some((f) => f.says.includes('subtype'))).toBe(true)
  })

  it('reports nothing when the subtype is simply absent', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    expect(readBoard(project).findings).toEqual([])
  })
})

describe('reading tests', () => {
  it('reads a test at the root of the tests container', () => {
    put('tests/login', 'test.yaml', 'name: Login\nsteps: click\nexpected: works\n')
    const board = readBoard(project)
    expect(board.tests.tests.map((t) => t.name)).toEqual(['Login'])
    expect(board.tests.tests[0].folderPath).toBe('tests/login')
  })

  // reason: a suite is a directory and nothing else, so depth is free and a
  // directory holding no test.yaml is a suite rather than a broken test.
  it('reads nested suites to any depth', () => {
    put('tests/auth/oauth/callback', 'test.yaml', 'name: Callback\n')
    const board = readBoard(project)
    expect(board.tests.suites.map((s) => s.slug)).toEqual(['auth'])
    expect(board.tests.suites[0].suites[0].slug).toBe('oauth')
    expect(board.tests.suites[0].suites[0].tests[0].name).toBe('Callback')
  })

  it('gives a test no status, because it is not work in flight', () => {
    put('tests/login', 'test.yaml', 'name: Login\n')
    expect(readBoard(project).tests.tests[0].status).toBe('')
  })

  it('reports a project with tests but no campaigns without failing', () => {
    put('tests/login', 'test.yaml', 'name: Login\n')
    const board = readBoard(project)
    expect(board.present).toBe(true)
    expect(board.campaigns).toEqual([])
  })

  it('answers with an empty tests root when there are none', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\n')
    expect(readBoard(project).tests).toEqual({ path: 'tests', slug: 'tests', suites: [], tests: [] })
  })
})

describe('findings about links', () => {
  beforeEach(() => {
    put('tests/login', 'test.yaml', 'name: Login\n')
  })

  it('says nothing about a link that resolves', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: pass\n')
    expect(readBoard(project).findings).toEqual([])
  })

  // reason: a validated_by entry that quietly vanished would turn "this is
  // proven" into "this was proven once" with nothing to say so.
  it('reports a link naming a test that is not there', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/gone\n    result: pass\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('tests/gone'))).toBe(true)
  })

  it('reports a result that is not one of the three', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: green\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('green'))).toBe(true)
  })

  // reason: a failure nobody wrote down should not read as fine.
  it('reports a failing link with no bug against it', () => {
    put('campaigns/q3', 'workitem.yaml', 'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: fail\n')
    expect(readBoard(project).findings.some((f) => f.says.includes('no bug'))).toBe(true)
  })

  it('says nothing about a failing link that names one', () => {
    put('campaigns/q3/bugs/b1', 'bug.yaml', 'name: B1\n')
    put(
      'campaigns/q3',
      'workitem.yaml',
      'name: Q3\nvalidated_by:\n  - test: tests/login\n    result: fail\n    bug: campaigns/q3/bugs/b1\n',
    )
    expect(readBoard(project).findings).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/board/board-read.spec.ts`
Expected: FAIL — `Board` has no `tests`, and `Entity` has no `level`.

- [ ] **Step 3: Implement**

In `src/main/board/board-read.ts`, change the imports:

```ts
import { boardRoot, fileFor, hasBoard, TESTS_DIR, TRASH_DIR } from './board-paths'
import {
  ENTITY_STATUSES,
  LINK_RESULTS,
  loadEntity,
  typeOf,
  type EntityFields,
  type EntityLevel,
} from './entity-schema'
```

Rename `Entity.kind` to `Entity.level` (type `EntityLevel`) and update its JSDoc. Add the suite type and widen `Board`:

```ts
/**
 * A directory under `tests/` that groups other tests.
 *
 * A suite has a slug and nothing else — no file, no status, no description —
 * because grouping is all it does, and a type that existed only to hold other
 * things is a type whose file nobody would ever fill in.
 */
export interface Suite {
  /** Its path within the board; `tests` for the root. */
  path: string
  slug: string
  suites: Suite[]
  tests: Entity[]
}
```

```ts
export interface Board {
  present: boolean
  campaigns: Entity[]
  /** The tests container. Always present, empty when there are none. */
  tests: Suite
  findings: Finding[]
}
```

Change `CHILDREN` to be keyed by level:

```ts
const CHILDREN: Partial<Record<EntityLevel, { dir: string; level: EntityLevel }[]>> = {
  campaign: [
    { dir: 'missions', level: 'mission' },
    { dir: 'bugs', level: 'bug' },
  ],
  mission: [
    { dir: 'tasks', level: 'task' },
    { dir: 'bugs', level: 'bug' },
  ],
}
```

In `readEntity`, take `level: EntityLevel` instead of `kind`, read `fileFor(level)` instead of `${kind}.yaml`, and replace the status and criteria checks with:

```ts
  const slug = folderPath.slice(folderPath.lastIndexOf('/') + 1)
  // A test has no status: it is not work in flight, it is the instrument the
  // work is measured with. An empty string rather than a default, so nothing
  // downstream can mistake it for a position on the board.
  const status = level === 'test' ? '' : (fields.status ?? 'draft')
  if (level !== 'test' && !(ENTITY_STATUSES as readonly string[]).includes(status)) {
    findings.push({ folderPath, says: `status "${status}" is not one the board knows.` })
  }
  // The path decides, because the path is what this walk followed. The key is
  // what the file claims, and a claim that disagrees is worth saying out loud
  // rather than quietly overruling.
  if (typeOf(level) === 'workitem' && fields.subtype !== undefined && fields.subtype !== level) {
    findings.push({ folderPath, says: `subtype says "${fields.subtype}" but this sits at ${level}.` })
  }
  if (level === 'task' && fields.acceptanceCriteria.length === 0) {
    findings.push({ folderPath, says: 'this task has no acceptance criterion, so nothing can gate it.' })
  }
```

Add the tests walk and the link check above `readBoard`:

```ts
/**
 * Read one directory under `tests/`, and everything below it.
 *
 * A directory holding a `test.yaml` is a test; one that does not is a suite,
 * and is walked. That rule is what makes a suite free: nothing declares one,
 * and a suite that stops holding tests stops existing without anybody
 * deleting a file.
 * @param root - the board root.
 * @param path - this directory's path within the board.
 * @param slug - its own name.
 * @param findings - collected, appended to.
 * @returns the suite, with its tests and sub-suites.
 */
function readSuite(root: string, path: string, slug: string, findings: Finding[]): Suite {
  const suite: Suite = { path, slug, suites: [], tests: [] }
  for (const name of subdirectories(join(root, path))) {
    const under = `${path}/${name}`
    const test = readEntity(root, under, 'test', findings)
    if (test !== undefined) suite.tests.push(test)
    else suite.suites.push(readSuite(root, under, name, findings))
  }
  return suite
}

/**
 * Every test on the board, by folder path.
 *
 * Flattened once per read rather than searched per link: a workitem with ten
 * links would otherwise walk the whole tests tree ten times. Exported because
 * the writer needs the same answer before it records a verdict, and two
 * flatteners over one tree are two chances to disagree about what a test is.
 * @param suite - the suite to flatten.
 * @param into - the set to add to.
 */
export function collectTests(suite: Suite, into: Set<string>): void {
  for (const test of suite.tests) into.add(test.folderPath)
  for (const child of suite.suites) collectTests(child, into)
}

/**
 * Check every workitem's links against the tests that exist.
 *
 * Three ways a link goes wrong, and each is reported rather than repaired: it
 * names a test that is not there, its verdict is not one of the three, or it
 * failed and nobody filed the bug. The last is the one worth having — a
 * failure nobody wrote down should not read as fine.
 * @param entities - the campaigns, walked in full.
 * @param tests - every test's folder path.
 * @param findings - collected, appended to.
 */
function checkLinks(entities: Entity[], tests: Set<string>, findings: Finding[]): void {
  const stack = [...entities]
  while (stack.length > 0) {
    const entity = stack.pop()!
    stack.push(...entity.children)
    for (const link of entity.fields.validatedBy) {
      if (!tests.has(link.test)) {
        findings.push({ folderPath: entity.folderPath, says: `validated_by names ${link.test}, which is not on the board.` })
      }
      if (!(LINK_RESULTS as readonly string[]).includes(link.result)) {
        findings.push({ folderPath: entity.folderPath, says: `result "${link.result}" is not one of pass, fail, not_run.` })
      }
      if (link.result === 'fail' && (link.bug ?? '') === '') {
        findings.push({ folderPath: entity.folderPath, says: `${link.test} failed and no bug was filed against it.` })
      }
    }
  }
}
```

In `readBoard`, replace the body after the `hasBoard` guard:

```ts
  const root = boardRoot(project)
  const findings: Finding[] = []
  const campaigns: Entity[] = []
  for (const name of subdirectories(join(root, 'campaigns'))) {
    const campaign = readEntity(root, `campaigns/${name}`, 'campaign', findings)
    if (campaign !== undefined) campaigns.push(campaign)
  }
  const tests = readSuite(root, TESTS_DIR, TESTS_DIR, findings)
  const known = new Set<string>()
  collectTests(tests, known)
  checkLinks(campaigns, known, findings)
  return { present: true, campaigns, tests, findings }
```

and make the absent-board return `{ present: false, campaigns: [], tests: { path: TESTS_DIR, slug: TESTS_DIR, suites: [], tests: [] }, findings: [] }`.

`findEntity` is unchanged — it walks campaigns only, which is what every caller means by it. Add a line to its JSDoc saying so: `Tests are not searched; they are addressed by path through the board's tests container.`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/board-read.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the failing-link finding is load-bearing**

Delete the `link.result === 'fail'` block from `checkLinks`. Re-run. Expected: "reports a failing link with no bug against it" fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/main/board/board-read.ts src/main/board/board-read.spec.ts
git commit -m "feat(board): read three types, a tests tree, and the links between them"
```

---

### Task 5: Writing three types, and the link that carries a verdict

**Files:**
- Modify: `src/main/board/board-write.ts`
- Test: `src/main/board/board-write.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, including `collectTests` from `./board-read`.
- Produces:
  ```ts
  export function createEntity(project: string, level: EntityLevel, parentFolder: string, name: string): WriteResult
  export function linkTest(project: string, folderPath: string, test: string, result: string, comment: string, bug?: string): WriteResult
  export function unlinkTest(project: string, folderPath: string, test: string): WriteResult
  export function recordRun(project: string, testFolder: string, workitem: string, result: string, at?: string): WriteResult
  ```
  `updateEntity`, `setStatus`, `addCriterion`, `tickCriterion`, `trashEntity` keep their signatures.

- [ ] **Step 1: Write the failing test**

In `src/main/board/board-write.spec.ts`, update the existing `read` helper to take a file name rather than a kind, and update every existing call and every `createEntity(project, 'campaign', …)`-style call, which now passes a **level** — the values are the same strings, so only `read`'s second argument changes:

```ts
/** The YAML on disk for one folder path. */
function read(folderPath: string, file: string): string {
  return readFileSync(join(project, '.dsh', 'tasks', folderPath, file), 'utf8')
}
```

Existing calls become `read('campaigns/q3', 'workitem.yaml')` and `read('campaigns/q3/bugs/crash', 'bug.yaml')`. Then append:

```ts
describe('creating a test', () => {
  it('puts a test in the tests container', () => {
    expect(createEntity(project, 'test', '', 'Login happy path')).toEqual({
      ok: true,
      folderPath: 'tests/login-happy-path',
    })
    expect(read('tests/login-happy-path', 'test.yaml')).toContain('name: Login happy path')
  })

  it('puts a test inside a suite when one is named', () => {
    expect(createEntity(project, 'test', 'tests/auth', 'Login')).toEqual({ ok: true, folderPath: 'tests/auth/login' })
  })

  it('creates the suite directories a nested parent implies', () => {
    expect(createEntity(project, 'test', 'tests/auth/oauth', 'Callback')).toMatchObject({
      folderPath: 'tests/auth/oauth/callback',
    })
    expect(readBoard(project).tests.suites[0].suites[0].tests[0].name).toBe('Callback')
  })

  // reason: a test has no status, so writing one would put it in a column it
  // does not belong in.
  it('writes no status on a test', () => {
    createEntity(project, 'test', '', 'Login')
    expect(read('tests/login', 'test.yaml')).not.toContain('status')
  })

  it('refuses a suite path outside the tests container', () => {
    expect(createEntity(project, 'test', 'campaigns/q3', 'Login').ok).toBe(false)
  })
})

describe('linkTest', () => {
  beforeEach(() => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'test', '', 'Login')
  })

  it('records a verdict on the workitem, not on the test', () => {
    expect(linkTest(project, 'campaigns/q3', 'tests/login', 'pass', '').ok).toBe(true)
    expect(read('campaigns/q3', 'workitem.yaml')).toContain('test: tests/login')
    expect(read('campaigns/q3', 'workitem.yaml')).toContain('result: pass')
    expect(read('tests/login', 'test.yaml')).not.toContain('campaigns/q3')
  })

  it('carries a comment and a bug', () => {
    createEntity(project, 'bug', 'campaigns/q3', 'Login 500')
    linkTest(project, 'campaigns/q3', 'tests/login', 'fail', 'returns 500', 'campaigns/q3/bugs/login-500')
    const text = read('campaigns/q3', 'workitem.yaml')
    expect(text).toContain('comment: returns 500')
    expect(text).toContain('bug: campaigns/q3/bugs/login-500')
  })

  // reason: linking the same test twice is ordinary — a re-run — and a second
  // entry would leave two verdicts for one pairing with no way to say which.
  it('replaces the verdict when the same test is linked again', () => {
    linkTest(project, 'campaigns/q3', 'tests/login', 'fail', 'first', 'campaigns/q3/bugs/x')
    linkTest(project, 'campaigns/q3', 'tests/login', 'pass', '')
    const links = readBoard(project).campaigns[0].fields.validatedBy
    expect(links).toHaveLength(1)
    expect(links[0].result).toBe('pass')
    // The bug from the old verdict goes with it: it described a failure that
    // is no longer the current answer.
    expect(links[0].bug).toBeUndefined()
  })

  it('refuses a result that is not one of the three', () => {
    const out = linkTest(project, 'campaigns/q3', 'tests/login', 'green', '')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('pass, fail, not_run')
  })

  it('refuses a test that is not on the board', () => {
    expect(linkTest(project, 'campaigns/q3', 'tests/gone', 'pass', '').ok).toBe(false)
  })

  // reason: a bug and a test do not declare what proves them.
  it('refuses to link anything to a bug or a test', () => {
    createEntity(project, 'bug', 'campaigns/q3', 'Crash')
    expect(linkTest(project, 'campaigns/q3/bugs/crash', 'tests/login', 'pass', '').ok).toBe(false)
    expect(linkTest(project, 'tests/login', 'tests/login', 'pass', '').ok).toBe(false)
  })
})

describe('unlinkTest', () => {
  it('removes the link and leaves the others', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'test', '', 'A')
    createEntity(project, 'test', '', 'B')
    linkTest(project, 'campaigns/q3', 'tests/a', 'pass', '')
    linkTest(project, 'campaigns/q3', 'tests/b', 'pass', '')
    expect(unlinkTest(project, 'campaigns/q3', 'tests/a').ok).toBe(true)
    expect(readBoard(project).campaigns[0].fields.validatedBy.map((l) => l.test)).toEqual(['tests/b'])
  })

  it('refuses a test that was never linked, rather than reporting success', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(unlinkTest(project, 'campaigns/q3', 'tests/never').ok).toBe(false)
  })
})

describe('recordRun', () => {
  beforeEach(() => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'test', '', 'Login')
  })

  it('appends a run to the test, not to the workitem', () => {
    expect(recordRun(project, 'tests/login', 'campaigns/q3', 'pass', '2026-09-05T09:00:00Z').ok).toBe(true)
    const runs = readBoard(project).tests.tests[0].fields.runs
    expect(runs).toEqual([{ at: '2026-09-05T09:00:00Z', workitem: 'campaigns/q3', result: 'pass' }])
    expect(read('campaigns/q3', 'workitem.yaml')).not.toContain('runs')
  })

  // reason: the run history is what makes flakiness visible, so a second run
  // of the same test against the same workitem is the whole point.
  it('keeps every run rather than replacing the last', () => {
    recordRun(project, 'tests/login', 'campaigns/q3', 'pass', 'a')
    recordRun(project, 'tests/login', 'campaigns/q3', 'fail', 'b')
    expect(readBoard(project).tests.tests[0].fields.runs.map((r) => r.result)).toEqual(['pass', 'fail'])
  })

  // reason: recording a run must not silently change the verdict — a verdict
  // is a claim with an author, and an automatic run is not one.
  it('does not touch the workitem it names', () => {
    linkTest(project, 'campaigns/q3', 'tests/login', 'pass', '')
    recordRun(project, 'tests/login', 'campaigns/q3', 'fail', 'a')
    expect(readBoard(project).campaigns[0].fields.validatedBy[0].result).toBe('pass')
  })

  it('refuses a result that is not one of the three', () => {
    expect(recordRun(project, 'tests/login', 'campaigns/q3', 'green', 'a').ok).toBe(false)
  })

  it('refuses a folder that is not a test', () => {
    expect(recordRun(project, 'campaigns/q3', 'campaigns/q3', 'pass', 'a').ok).toBe(false)
  })
})
```

Add `linkTest`, `unlinkTest`, `recordRun` to the file's import from `./board-write`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/board/board-write.spec.ts`
Expected: FAIL — the three functions do not exist.

- [ ] **Step 3: Implement**

In `src/main/board/board-write.ts`, change the imports to bring in `fileFor`, `TESTS_DIR`, `LINK_RESULTS`, `typeOf`, and `type EntityLevel`.

Rename every `kind` to `level` and every `EntityKind` to `EntityLevel`. In `open()`, return `level` rather than `kind`. In `save()`, take a level and write `fileFor(level)`.

Replace `PARENT_OF` and the parent check in `createEntity`:

```ts
/** Which level may hold which, so a parent of the wrong level is refused rather than nested. */
const PARENT_OF: Record<EntityLevel, readonly EntityLevel[]> = {
  campaign: [],
  mission: ['campaign'],
  task: ['mission'],
  // A bug is parented by exactly one of a campaign or a mission.
  bug: ['campaign', 'mission'],
  // A test's parent is a suite, which is a directory rather than an entity —
  // checked by path instead, since there is nothing to look up.
  test: [],
}
```

In `createEntity`, replace the parent resolution with:

```ts
  if (name.trim() === '') return { ok: false, reason: `Name the ${level} first.` }
  const board = readBoard(project)
  let parts: string[]
  if (level === 'test') {
    // A suite is a directory and nothing else, so there is no entity to look
    // up — only a path to check. An empty parent means the tests root.
    const suite = parentFolder === '' ? TESTS_DIR : parentFolder
    if (suite !== TESTS_DIR && !suite.startsWith(`${TESTS_DIR}/`)) {
      return { ok: false, reason: `${parentFolder} is not inside the tests container.` }
    }
    if (resolveInBoard(project, suite) === undefined) {
      return { ok: false, reason: `${suite} is not inside this project's board.` }
    }
    parts = suite === TESTS_DIR ? [] : suite.slice(TESTS_DIR.length + 1).split('/')
  } else if (level === 'campaign') {
    parts = []
  } else {
    if (resolveInBoard(project, parentFolder) === undefined) {
      return { ok: false, reason: `${parentFolder} is not inside this project's board.` }
    }
    const parent = findEntity(board, parentFolder)
    if (parent === undefined) return { ok: false, reason: `${parentFolder} is not on the board.` }
    if (!PARENT_OF[level].includes(parent.level)) {
      return { ok: false, reason: `a ${level} cannot go under a ${parent.level}.` }
    }
    // The odd segments, not a filter on the words: a campaign legitimately
    // slugged `missions` would otherwise be dropped from its children's paths.
    parts = parentFolder.split('/').filter((_, at) => at % 2 === 1)
  }
```

and the sibling-directory computation with:

```ts
  const under =
    level === 'test'
      ? join(boardRoot(project), TESTS_DIR, ...parts)
      : level === 'campaign'
        ? join(boardRoot(project), 'campaigns')
        : join(resolveInBoard(project, parentFolder)!, SIBLING_DIR[level])
```

where `SIBLING_DIR` is a new constant beside `PARENT_OF`:

```ts
/** The directory a level's siblings share, under its parent. */
const SIBLING_DIR: Record<EntityLevel, string> = {
  campaign: 'campaigns',
  mission: 'missions',
  task: 'tasks',
  bug: 'bugs',
  test: TESTS_DIR,
}
```

The `save` call becomes:

```ts
  save(dir, level, {
    name,
    description: '',
    acceptanceCriteria: [],
    documents: [],
    validatedBy: [],
    runs: [],
    ...(level === 'test' ? {} : { status: 'draft' }),
  })
```

Add the three new functions at the end of the file:

```ts
/**
 * Say that a test proves a workitem, and what happened when it was run.
 *
 * The verdict lands on the workitem rather than on the test, because a
 * verdict is about a pairing: one test can pass for the mission it was
 * written for and fail for the one that reused it, and both are true at once.
 *
 * Linking the same test twice replaces the verdict rather than adding a
 * second — a re-run is ordinary, and two verdicts for one pairing would leave
 * no way to say which is current. The old entry's bug goes with it: it
 * described a failure that is no longer the answer.
 * @param project - the project's root directory.
 * @param folderPath - the workitem being proved.
 * @param test - the test's folder path.
 * @param result - one of `LINK_RESULTS`.
 * @param comment - why, in the reader's own words; may be empty.
 * @param bug - the defect a failure produced, when one was filed.
 * @returns the workitem's folder path, or why nothing was linked.
 */
export function linkTest(
  project: string,
  folderPath: string,
  test: string,
  result: string,
  comment: string,
  bug?: string,
): WriteResult {
  if (!(LINK_RESULTS as readonly string[]).includes(result)) {
    return { ok: false, reason: `"${result}" is not a result. Use one of: ${LINK_RESULTS.join(', ')}.` }
  }
  const found = open(project, folderPath)
  if (!found.ok) return found
  if (typeOf(found.level) !== 'workitem') {
    return { ok: false, reason: `a ${found.level} does not declare what proves it.` }
  }
  const board = readBoard(project)
  const tests = new Set<string>()
  collectTests(board.tests, tests)
  if (!tests.has(test)) return { ok: false, reason: `${test} is not a test on this board.` }
  const kept = found.fields.validatedBy.filter((link) => link.test !== test)
  const link = { test, result, comment, ...(bug === undefined || bug === '' ? {} : { bug }) }
  save(found.dir, found.level, { ...found.fields, validatedBy: [...kept, link] })
  return { ok: true, folderPath }
}

/**
 * Stop claiming that a test proves a workitem.
 *
 * This is how a test is retired: validation *is* the link, so a test nothing
 * points at proves nothing, which is exactly what retired means. A test that
 * was never linked is refused rather than reported as removed — saying a
 * thing was unlinked when it never was is how a stale board looks tidy.
 * @param project - the project's root directory.
 * @param folderPath - the workitem to unlink from.
 * @param test - the test's folder path.
 * @returns the workitem's folder path, or why nothing changed.
 */
export function unlinkTest(project: string, folderPath: string, test: string): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  const kept = found.fields.validatedBy.filter((link) => link.test !== test)
  if (kept.length === found.fields.validatedBy.length) {
    return { ok: false, reason: `${folderPath} does not name ${test}.` }
  }
  save(found.dir, found.level, { ...found.fields, validatedBy: kept })
  return { ok: true, folderPath }
}

/**
 * Append one execution to a test's own history.
 *
 * Deliberately does not touch the workitem's verdict. A verdict is a claim
 * with an author; a run is a thing that happened. Letting a run rewrite a
 * verdict would put a claim on the board that nobody made — and the two
 * disagreeing is exactly the signal that a verdict has gone stale.
 * @param project - the project's root directory.
 * @param testFolder - the test that ran.
 * @param workitem - the workitem it was run against.
 * @param result - one of `LINK_RESULTS`.
 * @param at - when it ran; now, in ISO 8601, when not given.
 * @returns the test's folder path, or why nothing was recorded.
 */
export function recordRun(
  project: string,
  testFolder: string,
  workitem: string,
  result: string,
  at?: string,
): WriteResult {
  if (!(LINK_RESULTS as readonly string[]).includes(result)) {
    return { ok: false, reason: `"${result}" is not a result. Use one of: ${LINK_RESULTS.join(', ')}.` }
  }
  const dir = resolveInBoard(project, testFolder)
  if (dir === undefined) return { ok: false, reason: `${testFolder} is not inside this project's board.` }
  let text: string
  try {
    text = readFileSync(join(dir, fileFor('test')), 'utf8')
  } catch {
    return { ok: false, reason: `${testFolder} is not a test.` }
  }
  const fields = loadEntity(text)
  const runs = [...fields.runs, { at: at ?? new Date().toISOString(), workitem, result }]
  save(dir, 'test', { ...fields, runs })
  return { ok: true, folderPath: testFolder }
}
```

`open()` cannot find a test — `findEntity` walks campaigns only — which is why `recordRun` reads the file itself. Add `readFileSync` and `loadEntity` to the imports, and add this helper beside `open()`:

`collectTests` is the flattener Task 4 exported — add it to the import from `./board-read` rather than writing a second one here, since two flatteners over one tree are two chances to disagree about what a test is.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/board-write.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the run-does-not-touch-the-verdict rule is load-bearing**

At the end of `recordRun`, before returning, add a call to `linkTest(project, workitem, testFolder, result, '')`. Re-run. Expected: "does not touch the workitem it names" fails. Remove it.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test` and `npx tsc -p tsconfig.json --noEmit`
Expected: `view-mcp.ts` still fails to compile — Task 6 fixes it. Every board test passes.

- [ ] **Step 7: Commit**

```bash
git add src/main/board/board-write.ts src/main/board/board-write.spec.ts
git commit -m "feat(board): create a test, link it to what it proves, record what it did"
```

---

### Task 6: The tools, taught the new model

**Files:**
- Modify: `src/main/view-mcp.ts`
- Test: `src/main/view-mcp.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `board_link` and `board_run`; `board_create` gains a subtype.

- [ ] **Step 1: Write the failing test**

In `src/main/view-mcp.spec.ts`, update the existing board tests' fixture files — `'campaigns/q3/campaign.yaml'` becomes `'campaigns/q3/workitem.yaml'`, and its body gains `subtype: campaign` — and the `board_create` calls gain a level. Then append inside `describe('the board tools', …)`:

```ts
  it('offers the two link tools alongside the rest', async () => {
    const url = await serve(deps(), 'editor')
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    const names = ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['board_link', 'board_run']))
  })

  it('creates a workitem at the level it was given', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('campaign Q3')
  })

  it('creates a test in the tests container', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    expect((await callTool(url, 'board_create', { level: 'test', name: 'Login' })).isError).toBeFalsy()
    expect(textOf(await callTool(url, 'board_read'))).toContain('tests/login')
  })

  it('links a test to a workitem and shows the verdict', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    await callTool(url, 'board_create', { level: 'test', name: 'Login' })
    const linked = await callTool(url, 'board_link', {
      folder: 'campaigns/q3',
      test: 'tests/login',
      result: 'pass',
    })
    expect(linked.isError).toBeFalsy()
    expect(textOf(await callTool(url, 'board_read'))).toContain('pass')
  })

  // reason: an agent learns the vocabulary from the refusal as much as from
  // the description.
  it('names the three results when it refuses one', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    await callTool(url, 'board_create', { level: 'test', name: 'Login' })
    const out = await callTool(url, 'board_link', { folder: 'campaigns/q3', test: 'tests/login', result: 'green' })
    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain('not_run')
  })

  it('records a run against a test', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    await callTool(url, 'board_create', { level: 'test', name: 'Login' })
    const out = await callTool(url, 'board_run', {
      test: 'tests/login',
      workitem: 'campaigns/q3',
      result: 'fail',
    })
    expect(out.isError).toBeFalsy()
  })
```

If the file's `deps()` helper does not yet accept a `project` override, extend it in that file's own style so it does.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/view-mcp.spec.ts`
Expected: FAIL — `board_link` and `board_run` are not registered, and `board_create` takes `kind`.

- [ ] **Step 3: Implement**

In `src/main/view-mcp.ts`, add `linkTest`, `unlinkTest` and `recordRun` to the import from `./board/board-write`, `type Suite` to the import from `./board/board-read`, and `LINK_RESULTS` to the import from `./board/entity-schema`.

In `renderBoard`, render the tests container beneath the campaigns and show each entity's verdicts:

```ts
  for (const campaign of board.campaigns) walk(campaign, 0)
  if (lines.length === 0) lines.push('The board is empty.')
  const suites: string[] = []
  const walkSuite = (suite: Suite, depth: number): void => {
    for (const test of suite.tests) suites.push(`${'  '.repeat(depth)}test ${test.name}\n${'  '.repeat(depth)}  ${test.folderPath}`)
    for (const child of suite.suites) {
      suites.push(`${'  '.repeat(depth)}suite ${child.slug}`)
      walkSuite(child, depth + 1)
    }
  }
  walkSuite(board.tests, 0)
  if (suites.length > 0) lines.push('', 'Tests:', ...suites)
```

and inside `walk`, after the criteria lines, add:

```ts
    for (const link of entity.fields.validatedBy) {
      const bug = link.bug === undefined ? '' : `  bug: ${link.bug}`
      lines.push(`${'  '.repeat(depth)}  [${link.result}] ${link.test}${bug}`)
    }
```

Change `board_create`'s schema and body:

```ts
      inputSchema: {
        level: z
          .enum(['campaign', 'mission', 'task', 'bug', 'test'])
          .describe('What to create. A campaign, mission and task are workitems at three altitudes.'),
        name: z.string().describe('The display name. The folder is named after it.'),
        parent: z
          .string()
          .optional()
          .describe(
            "The parent's folder path from board_read. Omit for a campaign, and for a test at the root of the tests container; for a test inside a suite, give the suite's path.",
          ),
      },
```

with its description replaced by:

```ts
      description:
        "Create something on the board. A campaign, mission and task are workitems at three altitudes: a campaign is an outcome, a mission an independently shippable slice of it, a task one small verifiable unit. A mission goes under a campaign, a task under a mission, and a bug under either. A test is different — it lives in the tests container rather than under any workitem, because a test is not work in flight but the instrument work is measured with; give `parent` a suite path like `tests/auth` to file it in one, and suites are created as needed. Give a task at least one acceptance criterion with board_criterion, and say what proves a workitem with board_link.",
```

and the handler passes `level` where it passed `kind`.

Register the two new tools beside the others:

```ts
  if (editor) server.registerTool(
    'board_link',
    {
      title: 'Say a test proves a workitem, and what it did',
      description:
        `Record that a test validates a workitem, with the verdict from the last time it ran: ${LINK_RESULTS.join(', ')}. The verdict lives on the workitem rather than on the test, because it is about the pairing — one test can pass for the mission it was written for and fail for the one that reused it. Linking the same test again replaces the verdict rather than adding a second. A failing verdict should name the bug it produced; a failure with no bug is reported as a gap. To stop claiming a test proves something, pass \`unlink\` — that is also how a test is retired, since validation is the link.`,
      inputSchema: {
        folder: z.string().describe('The workitem being proved, by folder path.'),
        test: z.string().describe("The test's folder path from board_read."),
        result: z.string().optional().describe(`One of: ${LINK_RESULTS.join(', ')}.`),
        comment: z.string().optional().describe('Why, in your own words.'),
        bug: z.string().optional().describe('The folder path of the bug a failure produced.'),
        unlink: z.boolean().optional().describe('True to remove the link instead of recording one.'),
      },
    },
    ({ folder, test, result, comment, bug, unlink }) => {
      const project = boardProject(deps.project())
      if (!project.ok) return refuse(project.reason)
      if (unlink === true) {
        const gone = unlinkTest(project.project, folder, test)
        return gone.ok ? done(`${folder} no longer names ${test}.`) : refuse(gone.reason)
      }
      const out = linkTest(project.project, folder, test, result ?? 'not_run', comment ?? '', bug)
      return out.ok ? done(`${test} now records ${result ?? 'not_run'} against ${folder}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_run',
    {
      title: 'Record that a test ran',
      description:
        `Append one execution to a test's own history: when it ran, what it ran against, and what came out. This does NOT change the verdict on any workitem — a verdict is a claim somebody makes, a run is a thing that happened, and the two disagreeing is the signal that a verdict has gone stale. Use board_link to change a verdict. The history is what makes a flaky test visible, and is capped at the most recent runs.`,
      inputSchema: {
        test: z.string().describe("The test's folder path from board_read."),
        workitem: z.string().describe('The workitem it was run against, by folder path.'),
        result: z.string().describe(`One of: ${LINK_RESULTS.join(', ')}.`),
      },
    },
    ({ test, workitem, result }) => {
      const project = boardProject(deps.project())
      if (!project.ok) return refuse(project.reason)
      const out = recordRun(project.project, test, workitem, result)
      return out.ok ? done(`Recorded ${result} for ${test}.`) : refuse(out.reason)
    },
  )
```

Update `board_status`'s description to add: `A test has no status — it is not work in flight. Use board_link to record what a test proved.`

- [ ] **Step 4: Run the tests, the suite and the typecheck**

Run: `npx vitest run src/main/view-mcp.spec.ts`, then `npm test`, then `npx tsc -p tsconfig.json --noEmit`
Expected: all pass, typecheck now fully clean.

- [ ] **Step 5: Prove the run-does-not-link rule reaches the agent**

Grep the file for the `board_run` description and confirm it says the run does not change a verdict. This is copy, not code: a rule an agent cannot read is a rule it will break.

- [ ] **Step 6: Update the README**

In `README.md`, replace the board paragraph's list of kinds with: `campaigns, missions, tasks, bugs and the tests that prove them`.

- [ ] **Step 7: Commit**

```bash
git add src/main/view-mcp.ts src/main/view-mcp.spec.ts README.md
git commit -m "feat(board): teach the tools three types, and the link that carries a verdict"
```

---

## Manual verification

No test drives a real agent, so this is checked by hand once:

1. Ask the agent to plan a small piece of work. Confirm the files on disk are `workitem.yaml` with a `subtype`, and that `git status` shows them.
2. Ask it to write a test for one of the tasks and link it. Confirm the test is under `.dsh/tasks/tests/` and the **verdict is in the workitem's file**, not the test's.
3. Ask it to record a run with a different result from the verdict. Confirm the verdict did **not** move, and that both are visible.
4. Delete a test folder by hand and re-read the board. Confirm the dangling link is reported and nothing was repaired.
5. Set a link to `fail` with no bug. Confirm that is reported as a gap.
