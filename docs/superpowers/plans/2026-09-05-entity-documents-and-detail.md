# Entity documents and the board's detail view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an entity file a markdown document a person can read, and make a click on a card open that entity inside the board instead of dropping raw YAML into the editor.

**Architecture:** Two halves that need each other. The store's file format becomes YAML frontmatter plus `##` markdown sections (`workitem.md`, `bug.md`, `test.md`), with the legacy `<type>.yaml` still readable and converted on first write — this is done by translating a legacy YAML map into the same document model everything downstream already consumes, so `EntityFields` and every caller of it keep their shapes. Then the board panel grows a second surface: a detail view drawn from the same read as the board, replacing the columns with a back control, plus a Tests destination so a test is reachable without knowing it exists.

**Tech Stack:** TypeScript, Electron 33, js-yaml v4 (`JSON_SCHEMA`), marked + DOMPurify (already vendored, GFM on), Vitest + jsdom.

**Spec:** `docs/notes/task-board.md` (the store) and `docs/notes/task-board-views.md` (the views). Both were amended for this plan; read the amended text, not your memory of it.

## Global Constraints

- **The renderer never imports from `src/main/`.** `tsconfig.json` excludes `src/renderer/pane/**` and `tsconfig.pane.json` compiles it separately. Shared vocabulary is re-declared on the renderer side deliberately (see `board-rows.ts`).
- **Renderer imports carry a `.ts` suffix** (`import { x } from './y.ts'`). Main-process imports do not.
- **No formatter is configured.** Never run `prettier`, `eslint --fix`, or any other formatter. Match the surrounding style by hand.
- **js-yaml stays at v4** and every `load` passes `{ schema: JSON_SCHEMA }`, so a bare ISO timestamp stays a string. v4 returns `undefined` for an empty document.
- **Every write goes through `writeFileAtomic`** (`src/main/atomic-write.ts`), and every path an agent supplies goes through `resolveInBoard` before anything touches disk. Neither rule is relaxed by anything in this plan.
- **Tests must be non-vacuous.** After writing a test, break the code it covers and confirm it fails. A test that passes against broken code is a defect, not coverage.
- **Never `git add -A`, `git add .`, or `git commit -a`.** The repository root holds untracked `index.js` and `tree-menu.js` that belong to the user. Stage named paths only.
- Run `npx vitest run` and `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit` before each commit.

---

### Task 1: The document model

**Files:**
- Create: `src/main/board/entity-doc.ts`
- Test: `src/main/board/entity-doc.spec.ts`

**Interfaces:**
- Consumes: nothing — this module is pure and depends only on `js-yaml`.
- Produces: `EntityDoc`, `splitDoc(text: string): EntityDoc`, `joinDoc(doc: EntityDoc): string`, `sectionOf(doc: EntityDoc, heading: string): string`, `parseChecklist(body: string): { text: string; done: boolean }[]`, `dumpChecklist(items: { text: string; done: boolean }[]): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/board/entity-doc.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dumpChecklist, joinDoc, parseChecklist, sectionOf, splitDoc } from './entity-doc'

describe('splitDoc', () => {
  it('reads the frontmatter, the lead, and each section in file order', () => {
    const doc = splitDoc('---\nname: Ship it\nstatus: executing\n---\n\nThe lead.\n\n## Notes\n\nA note.\n')
    expect(doc.front).toEqual({ name: 'Ship it', status: 'executing' })
    expect(doc.lead).toBe('The lead.')
    expect(doc.sections).toEqual([{ heading: 'Notes', body: 'A note.' }])
  })

  it('treats a file with no frontmatter fence as all body', () => {
    const doc = splitDoc('Just prose.\n')
    expect(doc.front).toEqual({})
    expect(doc.lead).toBe('Just prose.')
  })

  it('keeps a heading deeper than two hashes inside the section it sits in', () => {
    const doc = splitDoc('---\n---\n\n## Steps\n\n### First\n\nDo it.\n')
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].body).toBe('### First\n\nDo it.')
  })

  it('does not mistake a hash inside a fenced code block for a heading', () => {
    const doc = splitDoc('---\n---\n\n## Steps\n\n```\n## not a heading\n```\n')
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].body).toBe('```\n## not a heading\n```')
  })

  it('answers with an empty front when the frontmatter is an empty document', () => {
    expect(splitDoc('---\n---\nBody.\n').front).toEqual({})
  })

  it('keeps a timestamp a string rather than resolving it to a date', () => {
    const doc = splitDoc('---\nat: 2026-09-05T09:12:00Z\n---\n')
    expect(doc.front.at).toBe('2026-09-05T09:12:00Z')
  })
})

describe('joinDoc', () => {
  it('round-trips a document byte for byte', () => {
    const text = '---\nname: Ship it\n---\n\nThe lead.\n\n## Notes\n\nA note.\n'
    expect(joinDoc(splitDoc(text))).toBe(text)
  })

  it('omits the lead when there is none, and still emits the fence', () => {
    expect(joinDoc({ front: { name: 'x' }, lead: '', sections: [] })).toBe('---\nname: x\n---\n')
  })

  it('separates every section by exactly one blank line', () => {
    const out = joinDoc({ front: {}, lead: 'Lead.', sections: [{ heading: 'A', body: 'a' }, { heading: 'B', body: 'b' }] })
    expect(out).toBe('---\n{}\n---\n\nLead.\n\n## A\n\na\n\n## B\n\nb\n')
  })
})

describe('sectionOf', () => {
  it('matches a heading regardless of case and surrounding space', () => {
    const doc = splitDoc('---\n---\n\n##   Steps to Reproduce  \n\nDo it.\n')
    expect(sectionOf(doc, 'Steps to Reproduce')).toBe('Do it.')
  })

  it('answers with an empty string for a heading the document does not have', () => {
    expect(sectionOf(splitDoc('---\n---\n'), 'Notes')).toBe('')
  })
})

describe('parseChecklist', () => {
  it('reads a ticked and an unticked line', () => {
    expect(parseChecklist('- [ ] one\n- [x] two')).toEqual([
      { text: 'one', done: false },
      { text: 'two', done: true },
    ])
  })

  it('takes a bare bullet as an unticked criterion', () => {
    expect(parseChecklist('- three')).toEqual([{ text: 'three', done: false }])
  })

  it('accepts an upper-case tick, because a person typed it', () => {
    expect(parseChecklist('- [X] one')).toEqual([{ text: 'one', done: true }])
  })

  it('drops blank lines rather than making an empty criterion of each', () => {
    expect(parseChecklist('- [ ] one\n\n\n- [ ] two')).toHaveLength(2)
  })

  it('round-trips through dumpChecklist', () => {
    const items = [{ text: 'one', done: true }, { text: 'two', done: false }]
    expect(parseChecklist(dumpChecklist(items))).toEqual(items)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/main/board/entity-doc.spec.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `src/main/board/entity-doc.ts`**

Write the module to satisfy exactly those tests. Required behaviour, in full:

- `EntityDoc` is `{ front: Record<string, unknown>; lead: string; sections: { heading: string; body: string }[] }`.
- `splitDoc(text)`: if the text begins with `---` followed by a newline, scan for the next line that is exactly `---` and parse everything between as YAML with `{ schema: JSON_SCHEMA }`, defaulting a non-object or `undefined` result to `{}`. Everything after that line is the body. With no opening fence, `front` is `{}` and the whole text is the body.
- Splitting the body: a section starts at a line matching `/^##\s+(.+?)\s*$/` **when it is not inside a fenced code block**. Track fences by toggling on any line whose trimmed form starts with ` ``` ` or `~~~`. Text before the first heading is `lead`. Every part is `.trim()`ed.
- `joinDoc(doc)`: `'---\n' + yamlDump(doc.front, { lineWidth: -1, noRefs: true }) + '---\n'`, then, when the lead is non-empty, `'\n' + lead + '\n'`, then for each section `'\n## ' + heading + '\n\n' + body + '\n'`. A section with an empty body still emits its heading (so a level's own sections are visible to write into) — emit `'\n## ' + heading + '\n'` in that case.
- `sectionOf(doc, heading)`: case-insensitive match on the trimmed heading; returns the body, or `''` when absent.
- `parseChecklist(body)`: one item per non-blank line. `- [ ] text` / `- [x] text` / `[x] text` set `done`; a bare `- text` or `* text` or `1. text` strips the marker and is unticked. Trim the text. This is octoshell's `checklist-field.tsx` parse, ported.
- `dumpChecklist(items)`: `- [ ] ` or `- [x] ` plus the trimmed text, one per line, skipping items whose text is blank, joined by `\n`.

Every exported symbol carries a JSDoc block in the house style — what it does, why it is that way, `@param`/`@returns`. Read `src/main/board/entity-schema.ts` for the voice.

- [ ] **Step 4: Run the tests and the typechecks**

Run: `npx vitest run src/main/board/entity-doc.spec.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Prove the tests are not vacuous**

Break `splitDoc` (make the fence-tracking always false), confirm the code-fence test fails, restore it. Break `dumpChecklist` (always emit `- [ ]`), confirm the round-trip test fails, restore it. Say in your report which tests caught which break.

- [ ] **Step 6: Commit**

```bash
git add src/main/board/entity-doc.ts src/main/board/entity-doc.spec.ts
git commit -m "feat(board): a document model — frontmatter, a lead, and sections"
```

---

### Task 2: The schema reads and writes documents

**Files:**
- Modify: `src/main/board/entity-schema.ts`
- Modify: `src/main/board/entity-schema.spec.ts`

**Interfaces:**
- Consumes: `EntityDoc`, `splitDoc`, `joinDoc`, `sectionOf`, `parseChecklist`, `dumpChecklist` from `./entity-doc`.
- Produces: `loadEntity(text: string): EntityFields` (now markdown-with-frontmatter), **new** `loadLegacyEntity(text: string): EntityFields` (the old all-YAML file), `dumpEntity(level, fields): string` (now emits markdown), `LEVEL_KEYS` (now frontmatter keys only), **new** `LEVEL_SECTIONS: Record<EntityLevel, readonly string[]>`. `EntityFields` gains `preconditions`, `testData`, `expectedFinalState`, `teardown`, and `extraSections`.

**What does not change:** `EntityType`, `WorkitemSubtype`, `EntityLevel`, `typeOf`, `EntityStatus`, `ENTITY_STATUSES`, `LinkResult`, `LINK_RESULTS`, `RUN_HISTORY`, `TestLink`, `TestRun`, `DocumentLink`, `yamlFailureReason`, and every existing field name on `EntityFields`. Callers outside this file see the same field names; only where those fields come from on disk changes.

- [ ] **Step 1: Decide the split, and write it into the types**

Frontmatter keys per level — this replaces the current `LEVEL_KEYS` values:

```ts
export const LEVEL_KEYS: Record<EntityLevel, readonly string[]> = {
  campaign: ['name', 'subtype', 'status', 'validated_by', 'documents'],
  mission: ['name', 'subtype', 'status', 'validated_by', 'documents'],
  task: ['name', 'subtype', 'status', 'role', 'validated_by'],
  bug: ['name', 'status', 'severity'],
  test: ['name', 'runs'],
}
```

Sections per level, in emission order:

```ts
export const LEVEL_SECTIONS: Record<EntityLevel, readonly string[]> = {
  campaign: ['Target', 'Acceptance Criteria', 'Notes'],
  mission: ['Acceptance Criteria', 'Notes'],
  task: ['Acceptance Criteria', 'Notes'],
  bug: ['Steps to Reproduce', 'Expected', 'Actual', 'RCA', 'Environment', 'Notes'],
  test: ['Preconditions', 'Test Data', 'Steps', 'Expected Final State', 'Teardown', 'Notes'],
}
```

`KNOWN_KEYS` becomes the union of every `LEVEL_KEYS` value. The description is the lead, at every level, and is never a key.

`EntityFields` keeps every field it has and adds:

```ts
  /** A test's setup, as `## Preconditions`. */
  preconditions?: string
  /** A test's fixture table, as `## Test Data`. */
  testData?: string
  /** A test's `## Expected Final State`. */
  expectedFinalState?: string
  /** A test's `## Teardown`. */
  teardown?: string
  /** Sections this schema does not model, carried through a round-trip and re-emitted last. */
  extraSections?: { heading: string; body: string }[]
```

`target`, `stepsToReproduce`, `expected`, `actual`, `rca`, `environment`, `steps`, `notes` all stay as fields; they are now read from and written to sections rather than keys.

- [ ] **Step 2: Write the failing tests**

Add to `src/main/board/entity-schema.spec.ts` — keep every existing test that is still true, and rewrite the ones asserting YAML bodies:

- `loadEntity` on a full bug document reads `name`/`status`/`severity` from frontmatter, the description from the lead, and `stepsToReproduce`/`expected`/`actual`/`rca`/`environment`/`notes` from their sections.
- `loadEntity` on a test document reads `preconditions`/`testData`/`steps`/`expectedFinalState`/`teardown` from their sections, and `runs` from frontmatter.
- `loadEntity` reads `acceptanceCriteria` from the `## Acceptance Criteria` checklist, ticked and unticked.
- `dumpEntity('task', fields)` emits `---` frontmatter with exactly `name`, `subtype`, `status`, `validated_by` (and `role` when set), then the lead, then `## Acceptance Criteria` and `## Notes`.
- `dumpEntity` then `loadEntity` round-trips every field for each of the five levels.
- A section the schema does not model survives a round-trip and is emitted after the modelled ones.
- A frontmatter key the schema does not model survives a round-trip.
- `dumpEntity('test', …)` emits no `status` key — the existing rule, still true.
- `dumpEntity` defaults status to `'idea'` — the existing rule, still true.
- `loadLegacyEntity` on the old all-YAML text yields the same `EntityFields` a converted document does: `description` from the `description` key, `stepsToReproduce` from `steps_to_reproduce`, a test's `steps` from `steps` and `expectedFinalState` from `expected`, `acceptanceCriteria` from the `acceptance_criteria` list of `{text, done}`, and `notes` from `notes`.
- `loadLegacyEntity` carries an unmodelled legacy key into `extra`.
- **The conversion test that matters:** `dumpEntity(level, loadLegacyEntity(oldYaml))` produces a document whose `loadEntity` equals `loadLegacyEntity(oldYaml)` — every field survives the trip from the old format to the new one.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/main/board/entity-schema.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

- `loadEntity(text)`: `splitDoc`, then map. `name`, `status`, `subtype`, `role`, `severity` from `front`; `validatedBy` from `front.validated_by` through the existing `parseLinks`; `documents` through `parseDocuments`; `runs` through `parseRuns`; `description` from `doc.lead`; every prose field from its section through `sectionOf`, kept `undefined` when the section is absent or blank; `acceptanceCriteria` from `parseChecklist(sectionOf(doc, 'Acceptance Criteria'))`; `extra` from the front keys outside `KNOWN_KEYS`; `extraSections` from the sections whose heading matches none in any `LEVEL_SECTIONS` value.
- `loadLegacyEntity(text)`: parse the whole text as YAML with `{ schema: JSON_SCHEMA }`, build an `EntityDoc` whose `front` is that map minus the prose keys and whose sections are those prose keys under their new headings (`description` → the lead, `steps_to_reproduce` → `Steps to Reproduce`, `expected` → `Expected` for a bug and `Expected Final State` for a test, `actual`, `rca`, `environment`, `target`, `steps`, `notes`), with `acceptance_criteria` serialised through `dumpChecklist`, then hand that document to the same mapping `loadEntity` uses. Do not duplicate the mapping — factor it into one `fieldsFrom(doc: EntityDoc): EntityFields` that both call. **A bug's `expected` and a test's `expected` land under different headings, so the translation needs the level.** Give `loadLegacyEntity(text, level: EntityLevel)` that parameter; `loadEntity(text)` needs no level because the heading in the file already says which it is.
- `dumpEntity(level, fields)`: build `front` in the existing order (`name`, `subtype` for a workitem, `status` unless a test, `role` on a task when set, `severity` on a bug defaulting to `'major'`, `validated_by` for a workitem, `documents` for campaign/mission, `runs` for a test capped at `RUN_HISTORY`), re-emit `extra` keys not in `LEVEL_KEYS[level]` last, then `joinDoc` with `fields.description` as the lead and `LEVEL_SECTIONS[level]` as the sections — `Acceptance Criteria` serialised through `dumpChecklist`, the rest from their fields — followed by `extraSections`.
- **State the loss in the JSDoc:** a criterion no longer carries extra keys (`AcceptanceCriterion`'s index signature survives on the type but nothing on disk can hold it), because a criterion is now a line of markdown. Keep the index signature so callers compile; note in the doc block that it is not persisted.

- [ ] **Step 5: Run everything**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: `entity-schema.spec.ts` green. Other suites will fail — Tasks 3 and 4 fix them. Report which fail and why; do not fix them here.

- [ ] **Step 6: Prove the round-trip test is not vacuous**

Drop `extraSections` from the `dumpEntity` output, confirm the unmodelled-section test fails, restore it.

- [ ] **Step 7: Commit**

```bash
git add src/main/board/entity-schema.ts src/main/board/entity-schema.spec.ts
git commit -m "feat(board): entity files are markdown with frontmatter"
```

---

### Task 3: Reading `.md`, and the `.yaml` that came before

**Files:**
- Modify: `src/main/board/board-paths.ts`, `src/main/board/board-paths.spec.ts`
- Modify: `src/main/board/board-read.ts`, `src/main/board/board-read.spec.ts`

**Interfaces:**
- Consumes: `loadEntity`, `loadLegacyEntity` from `./entity-schema`.
- Produces: `fileFor(level)` now returns `<type>.md`; **new** `legacyFileFor(level: EntityLevel): string` returning `<type>.yaml`. `readBoard` is unchanged in signature and in the shape of `Board`, `Entity`, `Suite` and `Finding`.

- [ ] **Step 1: Write the failing tests**

In `board-paths.spec.ts`: `fileFor('mission')` is `'workitem.md'`, `fileFor('bug')` is `'bug.md'`, `fileFor('test')` is `'test.md'`; `legacyFileFor` gives the `.yaml` names. Every existing `resolveInBoard` test stays exactly as it is — the security boundary is not touched by this plan.

In `board-read.spec.ts`, using the existing temp-directory fixtures:
- an entity folder holding `workitem.md` is read from it;
- an entity folder holding only `workitem.yaml` is read through `loadLegacyEntity`, with its description and criteria intact;
- an entity folder holding **both** is read from the `.md`, **and produces a finding** naming the folder and saying the `.yaml` is being ignored;
- a malformed `.md` yields a finding and no entity, as a malformed file already does.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/main/board/board-paths.spec.ts src/main/board/board-read.spec.ts`

- [ ] **Step 3: Implement**

- `board-paths.ts`: `fileFor` returns `` `${typeOf(level)}.md` ``; add `legacyFileFor` returning `` `${typeOf(level)}.yaml` ``. Update the JSDoc on `fileFor` — it currently says a reader looking for `mission.yaml` finds nothing; keep the point, change the extension.
- `board-read.ts`: wherever it reads an entity file today, read `fileFor(level)` if it exists, else `legacyFileFor(level)` through `loadLegacyEntity(text, level)`. When both exist, read the `.md` and push a `Finding` whose `says` is one line: `` `workitem.yaml is ignored; workitem.md is what the board reads` `` (with the right names for the level). One line, as `Finding` requires.

- [ ] **Step 4: Run the store's suites**

Run: `npx vitest run src/main/board && npx tsc -p tsconfig.json --noEmit`
Expected: `board-write.spec.ts` still fails (Task 4); everything else green.

- [ ] **Step 5: Prove the fallback is load-bearing**

Delete the legacy branch, confirm the `.yaml`-only test fails, restore it.

- [ ] **Step 6: Commit**

```bash
git add src/main/board/board-paths.ts src/main/board/board-paths.spec.ts src/main/board/board-read.ts src/main/board/board-read.spec.ts
git commit -m "feat(board): read workitem.md, fall back to the yaml that came before"
```

---

### Task 4: Writing converts

**Files:**
- Modify: `src/main/board/board-write.ts`, `src/main/board/board-write.spec.ts`

**Interfaces:**
- Consumes: `fileFor`, `legacyFileFor`, `resolveInBoard`, `loadEntity`, `loadLegacyEntity`, `dumpEntity`.
- Produces: no signature changes. `createEntity`, `updateEntity`, `setStatus`, `addCriterion`, `tickCriterion`, `trashEntity`, `linkTest`, `unlinkTest`, `recordRun` all keep their shapes.

- [ ] **Step 1: Write the failing tests**

- every write on a folder holding only `<type>.yaml` leaves `<type>.md` on disk with the same content and **no `<type>.yaml`**;
- the `.yaml` is removed only after the `.md` write succeeded — assert the order by making the atomic write throw and confirming the `.yaml` is still there;
- `createEntity` writes a `.md` and never a `.yaml`;
- `addCriterion` on a task appends a `- [ ]` line to `## Acceptance Criteria`, creating the section when it is absent;
- `tickCriterion` flips exactly one line's `[ ]` to `[x]` and leaves the others and the surrounding prose byte-identical;
- `addCriterion` still refuses a bug and a test — the `LEVEL_KEYS`-driven guard becomes a `LEVEL_SECTIONS`-driven one, and it must still refuse rather than report `ok: true` and discard the write. **This is a regression the last fix wave already caught once; keep a test on it.**
- `updateEntity` on a test writes its `## Steps` and `## Preconditions`;
- `recordRun` appends to frontmatter `runs` and caps at `RUN_HISTORY`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/main/board/board-write.spec.ts`

- [ ] **Step 3: Implement**

- The shared `open()` helper reads `.md` when present and the legacy `.yaml` otherwise, and returns which it read.
- `save()` writes `dumpEntity(level, fields)` to `fileFor(level)` through `writeFileAtomic`, and **then**, only when the entity was opened from a legacy file, `unlinkSync` the `.yaml`. Wrap the unlink in a try/catch that swallows nothing silently — on failure, leave the `.yaml` and let the reader's finding say it is being ignored. The unlink must never run before the atomic write resolves.
- The criterion functions operate on `fields.acceptanceCriteria` exactly as they do now; the section serialisation is `dumpEntity`'s job, so those two functions barely change beyond the guard.

- [ ] **Step 4: Run the whole store, then the whole suite**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit`
Expected: green, except any renderer spec that hardcodes `workitem.yaml` — fix those string literals here, they are one word each.

- [ ] **Step 5: Prove the ordering test is not vacuous**

Move the unlink above the atomic write, confirm the ordering test fails, restore it.

- [ ] **Step 6: Commit**

```bash
git add src/main/board/board-write.ts src/main/board/board-write.spec.ts
git commit -m "feat(board): a write converts the entity to markdown"
```

---

### Task 5: The agent's tools speak sections

**Files:**
- Modify: `src/main/view-mcp.ts`, `src/main/view-mcp.spec.ts`
- Modify: `docs/notes/task-board.md` (the *The agent's tools* section only)

**Interfaces:**
- Consumes: the store, unchanged in signature.
- Produces: `board_update` gains the new test inputs; every tool keeps its name.

- [ ] **Step 1: Write the failing tests**

- `board_update` accepts `preconditions`, `test_data`, `expected_final_state` and `teardown` on a test, and writes them;
- `board_update` still accepts `steps` on a test — the field that six write paths could not reach before;
- `board_read`'s rendered output names `workitem.md` rather than `workitem.yaml` wherever it names a file;
- every existing tool test still passes.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/main/view-mcp.spec.ts`

- [ ] **Step 3: Implement**

Add the four zod inputs beside the existing `steps`, map them to the new `EntityFields`, and update any string in `renderBoard` that names a file. Nothing else in this file changes.

- [ ] **Step 4: Update the spec's tools section**

In `docs/notes/task-board.md`, under *The agent's tools*, name the new `board_update` inputs and say in one sentence that an entity is a markdown document, so an agent writing a test writes markdown into `steps` and the rest — a table is a table.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run && npx tsc -p tsconfig.json --noEmit
git add src/main/view-mcp.ts src/main/view-mcp.spec.ts docs/notes/task-board.md
git commit -m "feat(board): the agent's tools write a test's sections"
```

---

### Task 6: One entity, over the bridge

**Files:**
- Modify: `src/main/board-ipc.ts`
- Modify: `src/main/index.ts` — the `tasks:read` handler is at `src/main/index.ts:2682`; register `tasks:detail` beside it, the same way
- Modify: `src/renderer/pane/bridge.ts`
- Modify: `src/main/board-ipc.spec.ts` (it exists)
- Modify: `src/main/index.spec.ts` — it already exercises `tasks:read` through a fake IPC (around line 2890); add the same shape of test for `tasks:detail`

**Interfaces:**
- Produces: `detailFor(project: string | undefined, folderPath: string): EntityDetailWire | undefined` in `board-ipc.ts`, and `window.pane.readTaskDetail(folderPath): Promise<EntityDetailWire | undefined>` on the bridge.

```ts
/** One entity, with everything a detail draws — the only place fields cross the bridge. */
export interface EntityDetailWire {
  level: string
  folderPath: string
  name: string
  status: string
  /** The parent's folder path and name, for the line under the heading. Absent for a campaign and a test. */
  parent?: { folderPath: string; name: string }
  /** The lead paragraph. */
  description: string
  /** `[{ heading, body }]` in the level's own order, blank ones included so the reader sees the shape. */
  sections: { heading: string; body: string }[]
  criteria: { text: string; done: boolean }[]
  /** Children as rows: tasks, bugs and sub-missions. */
  children: { level: string; folderPath: string; name: string; status: string }[]
  /** What validates this workitem. `name` is the test's own name, resolved here. */
  links: { test: string; name: string; result: string; comment: string; bug?: string }[]
  /** For a test: which workitems point at it, and with what verdict. */
  validates: { folderPath: string; name: string; result: string }[]
  /** The file to hand the editor when Open file is pressed. */
  file: string
}
```

- [ ] **Step 1: Write the failing tests**

Against a temp board: a mission's detail carries its parent, its criteria, its task and bug children as rows, and its links with each test's resolved name; a test's detail carries `validates` with the workitems pointing at it; an unknown folder path answers `undefined`; a detail's `sections` include a level's blank sections.

- [ ] **Step 2: Run, fail, implement**

`detailFor` reads the board the same way `boardFor` does — a full read, no cache — walks to the entity by folder path, and cuts it. `sections` come from `LEVEL_SECTIONS[level]` paired with the fields. Resolve every link's test name by looking it up in the board's tests. Register the IPC handler beside `tasks:read`, and add the method to the bridge's `window.pane` type and its preload implementation exactly as `readTasks` is done.

- [ ] **Step 3: Run everything and commit**

```bash
npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add src/main/board-ipc.ts src/main/board-ipc.spec.ts src/renderer/pane/bridge.ts src/main/index.ts src/main/index.spec.ts
git commit -m "feat(board): one entity's detail, over the bridge"
```

---

### Task 7: The detail view

**Files:**
- Create: `src/renderer/pane/board-detail.ts`, `src/renderer/pane/board-detail.spec.ts`
- Modify: `src/renderer/pane/board.ts`, `src/renderer/pane/board.spec.ts`
- Modify: `src/renderer/pane.html`, `src/renderer/pane.css`

**Interfaces:**
- Consumes: `EntityDetailWire` from `./bridge.ts`, `renderMarkdown` from `./markdown.ts`, `BOARD_STATUSES` and `statusLabel` from `./board-rows.ts`.
- Produces: `renderDetail(detail: EntityDetailWire, on: DetailActions): HTMLElement` — a pure function from data to DOM, so it is testable in jsdom without the bridge.

```ts
export interface DetailActions {
  back: () => void
  open: (folderPath: string) => void      // a child row or a link row
  openFile: (folderPath: string, file: string) => void
  setStatus: (folderPath: string, status: string) => void
  tick: (folderPath: string, index: number, done: boolean) => void
}
```

- [ ] **Step 1: Write the failing tests**

In jsdom, against a fixture `EntityDetailWire`:
- the heading carries the name and the status;
- the parent line is drawn when there is a parent and omitted when there is not;
- the back control calls `back` once;
- **a section's body renders as HTML** — a `| a | b |` table fixture produces a `<table>`, which is the whole reason the format changed;
- a blank section renders its heading and a muted "nothing here yet" line rather than an empty gap;
- the status select lists the five statuses by their labels and calls `setStatus` with the raw value;
- a criterion's checkbox calls `tick` with its index;
- a child row calls `open` with that child's folder path;
- a link row shows the test's name and its verdict, and a `fail` verdict is marked as failing the way a card's chip is;
- Open file calls `openFile` with the detail's `file`;
- **markdown is sanitised**: a section body containing `<img src=x onerror=alert(1)>` renders without the handler.

In `board.spec.ts`: clicking a card asks for the detail rather than opening a file; back returns to the columns; a redraw while a detail is open redraws the detail, not the board.

- [ ] **Step 2: Run, fail**

Run: `npx vitest run src/renderer/pane/board-detail.spec.ts src/renderer/pane/board.spec.ts`

- [ ] **Step 3: Implement `board-detail.ts`**

Build the DOM in the order the spec fixes: a header row with the back control, the name, the status pill and Open file; the parent line; the description; the status select; `## Acceptance Criteria` as real checkboxes; every other section as `renderMarkdown` output inserted with `innerHTML` — which is safe here and only here because `renderMarkdown` sanitises, and this is the same call the editor's preview already makes; then Children, then Validated by (or Validates, for a test).

- [ ] **Step 4: Wire it into `board.ts`**

Add module state `detail: EntityDetailWire | undefined`. A card's click sets it from `readTaskDetail` and redraws; `draw()` renders the detail into `#board-groups` when it is set and the columns when it is not. `refresh()` re-reads an open detail alongside the board, and falls back to the columns with a note when the entity is gone. A project change clears it, beside `refusal` and `revealed`. The tree's reveal clears it, so a reveal always lands on the board. Do not touch the modal, the drag, or the create path.

Add the markup `pane.html` needs — a `#board-detail` container is not required if the detail renders into `#board-groups`; prefer that, and say so in the report.

- [ ] **Step 5: Style it in `pane.css`**

Readable measure — the detail is prose, so cap it at about `68ch` and left-align it, not the full panel width. Match the existing token vocabulary; no new colours.

- [ ] **Step 6: Prove and commit**

Break the sanitiser call (insert the raw body), confirm the sanitisation test fails, restore it.

```bash
npx vitest run && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/board-detail.ts src/renderer/pane/board-detail.spec.ts src/renderer/pane/board.ts src/renderer/pane/board.spec.ts src/renderer/pane.html src/renderer/pane.css
git commit -m "feat(board): a card opens its detail, with a way back"
```

---

### Task 8: Tests on the board, and the design pass

**Files:**
- Modify: `src/renderer/pane/board.ts`, `src/renderer/pane/board.spec.ts`
- Modify: `src/renderer/pane/tasks-tree.ts`, `src/renderer/pane/tasks-tree.spec.ts`
- Modify: `src/renderer/pane.html`, `src/renderer/pane.css`
- Modify: `docs/notes/task-board-views.md` only if the build shows the spec wrong

- [ ] **Step 1: Write the failing tests**

- the board's header carries a Tests control;
- pressing it draws the suite tree: suites as headings, tests as rows with their `validates` counts;
- a test row opens that test's detail;
- pressing back from the Tests destination returns to the columns;
- `tasks-tree.ts`'s test row opens the test's **detail** rather than `test.yaml`.

- [ ] **Step 2: Run, fail, implement**

The Tests destination is the same surface swap the detail is: a third thing `draw()` can render into `#board-groups`. Reuse the suite data already on `BoardViewData.tests` — no new IPC.

- [ ] **Step 3: See it**

Build unsigned and look at it:

```bash
npm run build && npx electron-builder --dir -c.mac.identity=null
```

Quit any running copy from the tray first — the app takes a single-instance lock. Open a project with a board, click a card, read the detail, press back, open Tests, open a test. **Judge the render, do not describe the source.** Fix what is wrong in `pane.css` and say what you changed and why.

- [ ] **Step 4: Reconcile the docs**

`docs/notes/task-board-views.md` describes what you just built. Where the build taught you something the spec got wrong, change the spec and say so in your report. Where the spec is right, change nothing.

- [ ] **Step 5: Run everything and commit**

```bash
npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/board.ts src/renderer/pane/board.spec.ts src/renderer/pane/tasks-tree.ts src/renderer/pane/tasks-tree.spec.ts src/renderer/pane.html src/renderer/pane.css docs/notes/task-board-views.md
git commit -m "feat(board): tests are somewhere you can get to"
```
