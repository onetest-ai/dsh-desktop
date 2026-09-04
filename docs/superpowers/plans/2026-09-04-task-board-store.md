# Task Board: The Store and the Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board that lives in `.dsh/tasks/` as YAML files, readable and writable by the desktop app and by the agent, with no UI.

**Architecture:** `src/main/board/` holds the store. The YAML round-trip is vendored from `@octoshell/board` — it is subtle, self-contained, and already tested. The reader, writer and validator are written fresh, because upstream's are dominated by a Markdown format and a migration path this board does not have. Six tools go into the MCP server the app already runs, gated against the open project the same way every path argument there already is.

**Tech Stack:** TypeScript (CommonJS main process), `js-yaml@^4.3.1` (already a dependency), `zod` (already a dependency), Vitest.

**Spec:** `docs/notes/task-board.md`

## Global Constraints

- **No formatter is configured.** Do NOT run `prettier`, `eslint --fix`, or any other formatter. Match the surrounding style by hand: 2-space indent, **no semicolons**, **single quotes**, ~120-column lines. Upstream octoshell uses semicolons and double quotes — vendored code must be restyled by hand.
- **Stage only the files your task names.** Never `git add -A`, `git add .`, or `git commit -a`. The repo root holds untracked `index.js` and `tree-menu.js` belonging to the user, which must never be committed.
- **Every exported symbol carries a JSDoc block** with `@param` and `@returns`, saying *why*, not *what*, in the voice of the surrounding code. Read a neighbouring file before writing one.
- Tests are colocated: `src/main/board/entity-schema.spec.ts` beside `entity-schema.ts`.
- **A status is never inferred.** No write to a child may change its parent's status. There is no rollup and no cascade.
- The status set is exactly `draft`, `executing`, `awaitingApproval`, `done`, `failed`, `cancelled`.
- **Reading never writes.** A malformed file yields a finding and an absent entity, never a repair.
- **Delete moves to `.dsh/tasks/.trash/`.** Nothing in this plan removes a board folder.
- Commands: `npm test`, `npx vitest run <file>`, `npx tsc -p tsconfig.json --noEmit`. The typecheck must be clean before every commit.
- Upstream source to copy from: `/Users/arozumenko/Development/octoshell/packages/board/`.

---

## File Structure

**Created, all under `src/main/board/`:**

| File | Responsibility |
| --- | --- |
| `entity-schema.ts` | Vendored. Parse and serialise one `<kind>.yaml` body. The only file that knows YAML. |
| `slug.ts` | Vendored. A filesystem-safe slug, and the first free `base-N`. |
| `board-paths.ts` | Where the board is, and whether a caller may touch it. The only file that resolves a path. |
| `board-read.ts` | Rebuild the whole board from disk, with findings. |
| `board-write.ts` | The six write operations. The only file that writes. |
| `README.md` | Vendoring provenance and refresh procedure. |

**Modified:** `src/main/view-mcp.ts` — six tools and their deps.

---

### Task 1: The schema, vendored

The YAML round-trip. Taken nearly verbatim because it is subtle — the `extra` passthrough exists because upstream destroyed a campaign's recorded decisions without it — and because its only import is `js-yaml`.

**Files:**
- Create: `src/main/board/entity-schema.ts`, `src/main/board/slug.ts`, `src/main/board/README.md`
- Test: `src/main/board/entity-schema.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type EntityKind = 'campaign' | 'mission' | 'task' | 'bug'
  export type EntityStatus = 'draft' | 'executing' | 'awaitingApproval' | 'done' | 'failed' | 'cancelled'
  export const ENTITY_STATUSES: readonly EntityStatus[]
  export interface AcceptanceCriterion { text: string; done: boolean; [extra: string]: unknown }
  export interface DocumentLink { label: string; target: string; [extra: string]: unknown }
  export interface EntityFields { name, description, acceptanceCriteria, documents, status?, role?, target?, severity?, stepsToReproduce?, expected?, actual?, rca?, environment?, notes?, extra? }
  export const KIND_KEYS: Record<EntityKind, readonly string[]>
  export function loadEntity(text: string): EntityFields
  export function dumpEntity(kind: EntityKind, f: EntityFields): string
  export function slugify(name: string): string
  export function uniqueSlug(base: string, taken: Set<string>): string
  ```

- [ ] **Step 1: Copy the two source files**

```bash
cp /Users/arozumenko/Development/octoshell/packages/board/src/entity-schema.ts src/main/board/entity-schema.ts
cp /Users/arozumenko/Development/octoshell/packages/board/src/slug.ts src/main/board/slug.ts
```

- [ ] **Step 2: Restyle and adapt them, by hand**

Four changes, and nothing else — do not refactor logic you did not have to touch:

1. **Style.** Remove every semicolon, change every double-quoted string to single quotes. No formatter: do it by hand.
2. **Imports.** `import { load as yamlLoad, dump as yamlDump } from 'js-yaml'` stays. In `slug.ts`, delete `import { newId } from "./types.js"` — `types.ts` is not vendored. Replace the `newId()` fallback with a slug derived from the text's own bytes so it is deterministic:

```ts
/**
 * Filesystem-safe slug from a display name.
 *
 * The fallback matters more than it looks: a name that is entirely
 * non-latin — a Cyrillic or CJK title — reduces to the empty string, and an
 * empty folder name is not a name. Upstream fell back to a random id; this
 * derives one from the name's own bytes instead, so the same name always
 * yields the same folder and a re-run does not scatter duplicates.
 * @param name - the display name.
 * @returns a slug safe to use as a directory name, never empty.
 */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '')
  if (s !== '') return s
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return `entity-${hash.toString(16).padStart(8, '0')}`
}
```

3. **Remove `Tokenomics`.** Delete the `Tokenomics` type, the `tokenomics` field on `EntityFields`, `parseTokenomics`, its call in `loadEntity`, its emit in `dumpEntity`, and `'tokenomics'` from `KIND_KEYS` and `KNOWN_KEYS`. The spec leaves tokenomics out. An existing `tokenomics:` key on disk then rides through `extra` untouched, which is the correct outcome.
4. **Type the status.** Add the `EntityStatus` type above `ENTITY_STATUSES` and type the constant `readonly EntityStatus[]`.

- [ ] **Step 3: Write the tests**

Create `src/main/board/entity-schema.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dumpEntity, ENTITY_STATUSES, loadEntity } from './entity-schema'
import { slugify, uniqueSlug } from './slug'

describe('loadEntity', () => {
  // reason: js-yaml v4 returns undefined for an empty document where v5 throws.
  // Upstream is on v5 and recorded being bitten by exactly this; this app is on
  // v4, so the guard is `?? {}` and an empty file must read as an empty entity.
  it('reads an empty file as an empty entity rather than throwing', () => {
    for (const text of ['', '   ', '\n\n', '# just a comment\n']) {
      expect(() => loadEntity(text)).not.toThrow()
      expect(loadEntity(text).name).toBe('')
    }
  })

  it('reads the keys a task carries', () => {
    const fields = loadEntity(
      'name: T1 - Do it\nstatus: executing\nrole: dev\ndescription: some words\n' +
        'acceptance_criteria:\n  - text: it works\n    done: true\n',
    )
    expect(fields.name).toBe('T1 - Do it')
    expect(fields.status).toBe('executing')
    expect(fields.role).toBe('dev')
    expect(fields.acceptanceCriteria).toEqual([{ text: 'it works', done: true }])
  })

  // reason: a criterion an agent annotated with evidence must not lose that
  // annotation the next time anything rewrites the file.
  it('keeps the extra keys on a criterion', () => {
    const fields = loadEntity('acceptance_criteria:\n  - text: t\n    done: false\n    evidence: log.txt\n')
    expect(fields.acceptanceCriteria[0].evidence).toBe('log.txt')
  })

  it('treats a criterion without text as no criterion at all', () => {
    expect(loadEntity('acceptance_criteria:\n  - done: true\n').acceptanceCriteria).toEqual([])
  })
})

describe('dumpEntity', () => {
  // reason: this is the regression that motivated `extra` upstream — a
  // campaign's recorded decisions were destroyed by an unrelated edit.
  it('re-emits a key it does not model', () => {
    const fields = loadEntity('name: C1\nowner: alice\ndescription: d\n')
    const again = loadEntity(dumpEntity('campaign', fields))
    expect(again.extra?.owner).toBe('alice')
  })

  // reason: the typed model must win for a key the kind owns, or clearing a
  // field would silently revert to whatever was last on disk.
  it('lets the kind clear a field it owns rather than carrying the old value back', () => {
    const fields = loadEntity('name: C1\nnotes: old decision\n')
    fields.notes = undefined
    expect(dumpEntity('campaign', fields)).not.toContain('old decision')
  })

  it('emits only the keys its kind uses', () => {
    const fields = loadEntity('name: B1\nseverity: blocker\nsteps_to_reproduce: click it\n')
    const bug = dumpEntity('bug', fields)
    expect(bug).toContain('steps_to_reproduce')
    expect(bug).not.toContain('acceptance_criteria')
    const task = dumpEntity('task', { ...fields, severity: undefined })
    expect(task).toContain('acceptance_criteria')
    expect(task).not.toContain('steps_to_reproduce')
  })

  it('defaults a missing status to draft rather than omitting it', () => {
    expect(dumpEntity('task', loadEntity('name: T\n'))).toContain('status: draft')
  })

  // reason: a round-trip that reorders or reformats turns every unrelated edit
  // into a large diff, which is the opposite of why the board is files.
  it('round-trips a full entity byte-identically the second time', () => {
    const once = dumpEntity('mission', loadEntity('name: M1\nstatus: done\ndescription: d\n'))
    expect(dumpEntity('mission', loadEntity(once))).toBe(once)
  })
})

describe('the status set', () => {
  it('is exactly the six the board draws', () => {
    expect([...ENTITY_STATUSES]).toEqual(['draft', 'executing', 'awaitingApproval', 'done', 'failed', 'cancelled'])
  })
})

describe('slugify', () => {
  it('makes a directory name from a title', () => {
    expect(slugify('M1 - Do the Thing!')).toBe('m1-do-the-thing')
  })

  // reason: a non-latin name reduces to nothing, and an empty folder name is
  // not a name. Deterministic so the same title never scatters duplicates.
  it('falls back deterministically for a name with nothing latin in it', () => {
    const first = slugify('Привет мир')
    expect(first).not.toBe('')
    expect(slugify('Привет мир')).toBe(first)
    expect(slugify('другое имя')).not.toBe(first)
  })

  it('numbers a slug that is already taken', () => {
    expect(uniqueSlug('m1', new Set(['m1', 'm1-2']))).toBe('m1-3')
  })
})
```

- [ ] **Step 4: Run them**

Run: `npx vitest run src/main/board/entity-schema.spec.ts`
Expected: PASS. If the empty-file test throws, the `?? {}` guard in `loadEntity` was lost in the restyle — restore it.

- [ ] **Step 5: Prove the passthrough is load-bearing**

In `dumpEntity`, delete the final `for (const [k, v] of Object.entries(f.extra ?? {}))` loop. Re-run. Expected: "re-emits a key it does not model" fails. Restore.

- [ ] **Step 6: Write the vendoring README**

Create `src/main/board/README.md`:

```markdown
# The board store

`entity-schema.ts` and `slug.ts` are vendored from
[`@octoshell/board`](https://github.com/onetest-ai/octoshell), `packages/board/src/`.

Taken because the YAML round-trip is subtle and already has scars on it: the
`extra` passthrough exists because a rewrite there destroyed a campaign's
recorded decisions, and re-deriving that lesson here would cost the same data.

**Not taken:** `board-model.ts` and `write.ts`. Upstream carries a Markdown
format, a migration off it, legacy id markers and workflow parsing — 1659 lines
of which most is what this board does not have. `board-read.ts` and
`board-write.ts` here are written for YAML and four kinds only.

## Changes made on the way in

- Restyled to this repo: no semicolons, single quotes. No formatter is configured here.
- `.js` import suffixes removed — this is a CommonJS build.
- `Tokenomics` removed; an existing `tokenomics:` key rides through `extra` untouched.
- `slugify`'s empty-name fallback is derived from the name rather than random, so it is deterministic.
- Root is `.dsh/tasks/`, not `.octobots/`.

## Refreshing

Re-copy the two files and re-apply the changes above. `entity-schema.spec.ts`
covers the behaviour that matters; a refresh that passes it has not regressed.
Upstream is on `js-yaml@^5`; this app is on `^4`, which differs on empty
files — the spec's *js-yaml version hazard* section says why we stay on v4.
```

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc -p tsconfig.json --noEmit`

```bash
git add src/main/board/entity-schema.ts src/main/board/slug.ts src/main/board/entity-schema.spec.ts src/main/board/README.md
git commit -m "feat(board): vendor the YAML round-trip"
```

---

### Task 2: Where the board is, and who may touch it

The only file that resolves a path. Separate from the reader and the writer because it is the security boundary: a path from the agent becomes a directory this app writes into.

**Files:**
- Create: `src/main/board/board-paths.ts`
- Test: `src/main/board/board-paths.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const BOARD_DIR: string                    // '.dsh/tasks'
  export const TRASH_DIR: string                    // '.trash'
  export function boardRoot(project: string): string
  export function hasBoard(project: string): boolean
  export function folderFor(kind: EntityKind, parts: string[]): string
  export function resolveInBoard(project: string, folderPath: string): string | undefined
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/board/board-paths.spec.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardRoot, folderFor, hasBoard, resolveInBoard } from './board-paths'

let project = ''
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dsh-board-'))
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

describe('boardRoot', () => {
  it('puts the board beside the project mcp.json', () => {
    expect(boardRoot('/p')).toBe(join('/p', '.dsh', 'tasks'))
  })
})

describe('hasBoard', () => {
  // reason: a project with no board is a state the panel words, not one this
  // repairs — creating a directory in someone's repository because they opened
  // a view is not a thing to do unasked.
  it('is false for a project that has no board, and creates nothing', () => {
    expect(hasBoard(project)).toBe(false)
    expect(hasBoard(project)).toBe(false)
  })

  it('is true once the directory exists', () => {
    mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
    expect(hasBoard(project)).toBe(true)
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
})

describe('resolveInBoard', () => {
  beforeEach(() => {
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3'), { recursive: true })
  })

  it('resolves a folder inside the board', () => {
    expect(resolveInBoard(project, 'campaigns/q3')).toBe(join(project, '.dsh', 'tasks', 'campaigns', 'q3'))
  })

  // reason: this is the boundary. A folder path arrives from the agent and
  // becomes a directory this app writes into and deletes from.
  it('refuses a path that climbs out of the board', () => {
    expect(resolveInBoard(project, '../../../etc')).toBeUndefined()
    expect(resolveInBoard(project, 'campaigns/../../..')).toBeUndefined()
  })

  it('refuses an absolute path', () => {
    expect(resolveInBoard(project, '/etc/passwd')).toBeUndefined()
  })

  // reason: a symlink inside the board pointing out of it escapes a check that
  // only compares strings, so the check resolves the real path of what exists.
  it('refuses a path whose real location is outside the board', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    const { symlinkSync } = require('node:fs') as typeof import('node:fs')
    symlinkSync(outside, join(project, '.dsh', 'tasks', 'campaigns', 'escape'))
    expect(resolveInBoard(project, 'campaigns/escape')).toBeUndefined()
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses the trash, which is not a place to act on entities', () => {
    expect(resolveInBoard(project, '.trash/campaigns/q3')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/board/board-paths.spec.ts`
Expected: FAIL — `Failed to resolve import './board-paths'`.

- [ ] **Step 3: Implement**

Create `src/main/board/board-paths.ts`:

```ts
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { EntityKind } from './entity-schema'

/** Where a project keeps its board, beside the `mcp.json` it may already carry. */
export const BOARD_DIR = join('.dsh', 'tasks')

/** Where a deleted entity goes. Never read as part of the board. */
export const TRASH_DIR = '.trash'

/**
 * The board directory of one project.
 *
 * Computed, never created. A project with no board is a state to report — a
 * view that made a directory in someone's repository because it was opened
 * would be writing to a working tree nobody asked it to touch.
 * @param project - the project's root directory.
 * @returns the board directory, whether or not it exists.
 */
export function boardRoot(project: string): string {
  return join(project, BOARD_DIR)
}

/**
 * Whether a project has a board at all.
 * @param project - the project's root directory.
 * @returns true when the board directory exists.
 */
export function hasBoard(project: string): boolean {
  try {
    return statSync(boardRoot(project)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The folder path of an entity, from the slugs of it and its parents.
 *
 * The path is the entity's identity — there is no id file — so this is the one
 * place the shape of the tree is written down. A bug takes two parts when a
 * campaign owns it and three when a mission does, which is what "parented by
 * exactly one" looks like on disk.
 * @param kind - which kind the last slug names.
 * @param parts - the slugs from the campaign down, ending with this entity's.
 * @returns the folder path, relative to the board root, with forward slashes.
 */
export function folderFor(kind: EntityKind, parts: string[]): string {
  const [campaign, ...rest] = parts
  if (kind === 'campaign') return `campaigns/${campaign}`
  if (kind === 'mission') return `campaigns/${campaign}/missions/${rest[0]}`
  if (kind === 'task') return `campaigns/${campaign}/missions/${rest[0]}/tasks/${rest[1]}`
  // A bug under a campaign has one slug after it; one under a mission has two.
  if (rest.length === 1) return `campaigns/${campaign}/bugs/${rest[0]}`
  return `campaigns/${campaign}/missions/${rest[0]}/bugs/${rest[1]}`
}

/**
 * Turn a folder path into a real directory, or refuse it.
 *
 * The security boundary of this module. A folder path reaches here from the
 * agent's tools, and what comes back is a directory this app writes into and
 * moves to the trash — so the check is against the resolved real path, not the
 * string. A symlink inside the board pointing outside it defeats any check
 * that only compares text, and `..` is the same attack spelled differently.
 *
 * The trash is refused as well. It holds folders that were deleted; acting on
 * one would resurrect an entity through a path the board no longer lists.
 * @param project - the project's root directory.
 * @param folderPath - the path within the board, as the board reports it.
 * @returns the absolute directory, or nothing when it is not inside the board.
 */
export function resolveInBoard(project: string, folderPath: string): string | undefined {
  if (folderPath === '' || isAbsolute(folderPath)) return undefined
  const root = boardRoot(project)
  const target = resolve(root, folderPath)
  // Resolved through realpath where it exists, so a symlink cannot point out.
  // Where it does not exist yet — a folder about to be created — the lexical
  // check is all there is, and it is enough: nothing has been followed.
  const real = existsSync(target) ? realpathSync(target) : target
  const base = existsSync(root) ? realpathSync(root) : root
  if (real !== base && !real.startsWith(base + sep)) return undefined
  if (real === join(base, TRASH_DIR) || real.startsWith(join(base, TRASH_DIR) + sep)) return undefined
  return real
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/board-paths.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the escape check is load-bearing**

Replace the `real`/`base` computation with the unresolved `target` and `root`. Re-run. Expected: "refuses a path whose real location is outside the board" fails. Restore.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.json --noEmit`

```bash
git add src/main/board/board-paths.ts src/main/board/board-paths.spec.ts
git commit -m "feat(board): where the board is, and who may touch it"
```

---

### Task 3: Reading the board

A pure rebuild from disk, with findings for what could not be read. No incremental invalidation: a board is tens to low hundreds of small files, a full read is milliseconds, and it cannot drift.

**Files:**
- Create: `src/main/board/board-read.ts`
- Test: `src/main/board/board-read.spec.ts`

**Interfaces:**
- Consumes: `loadEntity`, `EntityFields`, `EntityKind`, `ENTITY_STATUSES` from `./entity-schema`; `boardRoot`, `hasBoard`, `TRASH_DIR` from `./board-paths`.
- Produces:
  ```ts
  export interface Entity {
    kind: EntityKind
    folderPath: string
    slug: string
    name: string
    status: string
    fields: EntityFields
    children: Entity[]
    progress: { done: number; total: number }
  }
  export interface Finding { folderPath: string; says: string }
  export interface Board { present: boolean; campaigns: Entity[]; findings: Finding[] }
  export function readBoard(project: string): Board
  export function findEntity(board: Board, folderPath: string): Entity | undefined
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/board/board-read.spec.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findEntity, readBoard } from './board-read'

let project = ''
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dsh-board-'))
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Write one entity file into the board.
 * @param folderPath - the folder within the board.
 * @param kind - which `<kind>.yaml` to write.
 * @param body - the YAML body.
 */
function put(folderPath: string, kind: string, body: string): void {
  const dir = join(project, '.dsh', 'tasks', folderPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${kind}.yaml`), body)
}

describe('readBoard', () => {
  it('reports a project with no board rather than failing', () => {
    const board = readBoard(project)
    expect(board.present).toBe(false)
    expect(board.campaigns).toEqual([])
    expect(board.findings).toEqual([])
  })

  it('reads a campaign, its mission, and its task', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\nstatus: executing\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\nstatus: draft\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\nstatus: done\n')
    const board = readBoard(project)
    expect(board.present).toBe(true)
    expect(board.campaigns).toHaveLength(1)
    expect(board.campaigns[0].name).toBe('Q3')
    expect(board.campaigns[0].children[0].name).toBe('M1')
    expect(board.campaigns[0].children[0].children[0].status).toBe('done')
  })

  it('reads a bug under a campaign and a bug under a mission', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/bugs/b1', 'bug', 'name: B1\nseverity: blocker\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\n')
    put('campaigns/q3/missions/m1/bugs/b2', 'bug', 'name: B2\n')
    const board = readBoard(project)
    const kinds = board.campaigns[0].children.map((child) => `${child.kind}:${child.name}`)
    expect(kinds).toContain('bug:B1')
    expect(kinds).toContain('mission:M1')
    const mission = board.campaigns[0].children.find((child) => child.kind === 'mission')
    expect(mission?.children.map((child) => child.name)).toEqual(['B2'])
  })

  // reason: children are folder-derived, so a folder with no entity file in it
  // is not an entity — and must not become an empty one with a slug for a name.
  it('skips a folder that holds no entity file', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    mkdirSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'missions', 'empty'), { recursive: true })
    expect(readBoard(project).campaigns[0].children).toEqual([])
  })

  // reason: reading never writes and never repairs. A file that will not parse
  // is a finding naming it, and an entity that is simply absent.
  it('reports a file it cannot parse and leaves it out', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: [unclosed\n')
    const board = readBoard(project)
    expect(board.campaigns[0].children).toEqual([])
    expect(board.findings).toHaveLength(1)
    expect(board.findings[0].folderPath).toBe('campaigns/q3/missions/m1')
  })

  // reason: a board whose columns are whatever anyone typed is not a board.
  it('reports a status that is not one of the six', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\nstatus: inprogress\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('inprogress'))).toBe(true)
  })

  // reason: a task with no checkable definition of done cannot be gated, and
  // gating is the point. Reported, never refused.
  it('reports a task with no acceptance criteria, and still reads it', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\n')
    const board = readBoard(project)
    expect(board.findings.some((f) => f.says.includes('acceptance criterion'))).toBe(true)
    expect(board.campaigns[0].children[0].children).toHaveLength(1)
  })

  // reason: progress is computed and shown; it is never written. This is the
  // rule the whole design is defined against.
  it('counts progress without touching any status', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\nstatus: draft\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\nstatus: draft\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\nstatus: done\n')
    put('campaigns/q3/missions/m1/tasks/t2', 'task', 'name: T2\nstatus: draft\n')
    const board = readBoard(project)
    const mission = board.campaigns[0].children[0]
    expect(mission.progress).toEqual({ done: 1, total: 2 })
    // The mission's own status is what its file says, whatever its children do.
    expect(mission.status).toBe('draft')
    expect(board.campaigns[0].status).toBe('draft')
  })

  it('never reads the trash', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('.trash/campaigns/gone', 'campaign', 'name: Gone\n')
    expect(readBoard(project).campaigns.map((c) => c.name)).toEqual(['Q3'])
  })

  it('sorts by slug so two reads of one board agree', () => {
    put('campaigns/b', 'campaign', 'name: B\n')
    put('campaigns/a', 'campaign', 'name: A\n')
    expect(readBoard(project).campaigns.map((c) => c.slug)).toEqual(['a', 'b'])
  })
})

describe('findEntity', () => {
  it('finds an entity anywhere in the tree by its folder path', () => {
    put('campaigns/q3', 'campaign', 'name: Q3\n')
    put('campaigns/q3/missions/m1', 'mission', 'name: M1\n')
    put('campaigns/q3/missions/m1/tasks/t1', 'task', 'name: T1\n')
    const board = readBoard(project)
    expect(findEntity(board, 'campaigns/q3/missions/m1/tasks/t1')?.name).toBe('T1')
    expect(findEntity(board, 'campaigns/nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/board/board-read.spec.ts`
Expected: FAIL — `Failed to resolve import './board-read'`.

- [ ] **Step 3: Implement**

Create `src/main/board/board-read.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardRoot, hasBoard, TRASH_DIR } from './board-paths'
import { ENTITY_STATUSES, loadEntity, type EntityFields, type EntityKind } from './entity-schema'

/** One entity, with the children its folder holds. */
export interface Entity {
  kind: EntityKind
  /** Its path within the board, which is also its identity. */
  folderPath: string
  slug: string
  name: string
  status: string
  fields: EntityFields
  /** Missions and bugs under a campaign; tasks and bugs under a mission. */
  children: Entity[]
  /**
   * How many of this entity's own children are `done`.
   *
   * Computed on every read and never written anywhere. Showing "1 of 2" is
   * what lets a person decide; it must not decide for them. See the spec's
   * *Status is set, never inferred*.
   */
  progress: { done: number; total: number }
}

/** Something the board could not read, or read and did not like. */
export interface Finding {
  folderPath: string
  /** One line, naming what is wrong. Never a stack trace. */
  says: string
}

/** The whole board, and what could not be read of it. */
export interface Board {
  /** False when the project has no `.dsh/tasks/` at all — a state, not a failure. */
  present: boolean
  campaigns: Entity[]
  findings: Finding[]
}

/** Which directory holds each kind's children, and what kind those are. */
const CHILDREN: Partial<Record<EntityKind, { dir: string; kind: EntityKind }[]>> = {
  campaign: [
    { dir: 'missions', kind: 'mission' },
    { dir: 'bugs', kind: 'bug' },
  ],
  mission: [
    { dir: 'tasks', kind: 'task' },
    { dir: 'bugs', kind: 'bug' },
  ],
}

/**
 * The subdirectories of one directory, sorted, or none when it cannot be read.
 *
 * Sorted so two reads of one board produce the same order — the board is drawn
 * from this, and a list that reordered between reads would move under the
 * cursor for no reason anyone could see.
 * @param dir - the directory to list.
 * @returns the child directory names, in order.
 */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== TRASH_DIR)
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Read one entity's folder, its file, and everything under it.
 *
 * Returns nothing for a folder with no `<kind>.yaml` in it. Children are
 * folder-derived, so a directory is a candidate rather than a declaration —
 * and a candidate that holds no entity file is not an entity. Inventing an
 * empty one named after its slug would put a thing on the board that nobody
 * created.
 * @param root - the board root.
 * @param folderPath - this entity's path within it.
 * @param kind - the kind its file must be.
 * @param findings - collected, appended to.
 * @returns the entity, or nothing when the folder holds none.
 */
function readEntity(root: string, folderPath: string, kind: EntityKind, findings: Finding[]): Entity | undefined {
  const dir = join(root, folderPath)
  let text: string
  try {
    text = readFileSync(join(dir, `${kind}.yaml`), 'utf8')
  } catch {
    return undefined
  }
  let fields: EntityFields
  try {
    fields = loadEntity(text)
  } catch (error) {
    // Reading never repairs: the file stays exactly as it is, and the board
    // says which one it could not read.
    findings.push({ folderPath, says: `${kind}.yaml could not be read: ${(error as Error).message}` })
    return undefined
  }
  const slug = folderPath.slice(folderPath.lastIndexOf('/') + 1)
  const status = fields.status ?? 'draft'
  if (!(ENTITY_STATUSES as readonly string[]).includes(status)) {
    findings.push({ folderPath, says: `status "${status}" is not one the board knows.` })
  }
  if (kind === 'task' && fields.acceptanceCriteria.length === 0) {
    findings.push({ folderPath, says: 'this task has no acceptance criterion, so nothing can gate it.' })
  }
  const children: Entity[] = []
  for (const under of CHILDREN[kind] ?? []) {
    for (const name of subdirectories(join(dir, under.dir))) {
      const child = readEntity(root, `${folderPath}/${under.dir}/${name}`, under.kind, findings)
      if (child !== undefined) children.push(child)
    }
  }
  return {
    kind,
    folderPath,
    slug,
    name: fields.name === '' ? slug : fields.name,
    status,
    fields,
    children,
    progress: { done: children.filter((child) => child.status === 'done').length, total: children.length },
  }
}

/**
 * Rebuild the whole board from disk.
 *
 * A full read every time, with no incremental invalidation and no cache. A
 * board is tens to low hundreds of small files, so the read is milliseconds —
 * and a rebuild cannot drift from disk, which is the property the whole design
 * is built to keep. If a board ever grows large enough for this to hurt, that
 * is a measurement to act on, not a prediction to design around.
 * @param project - the project's root directory.
 * @returns the campaigns and what could not be read.
 */
export function readBoard(project: string): Board {
  if (!hasBoard(project)) return { present: false, campaigns: [], findings: [] }
  const root = boardRoot(project)
  const findings: Finding[] = []
  const campaigns: Entity[] = []
  for (const name of subdirectories(join(root, 'campaigns'))) {
    const campaign = readEntity(root, `campaigns/${name}`, 'campaign', findings)
    if (campaign !== undefined) campaigns.push(campaign)
  }
  return { present: true, campaigns, findings }
}

/**
 * One entity by its folder path.
 *
 * A walk rather than an index: the board is already in memory and small, and a
 * second structure keyed by path is a second thing that can disagree with the
 * first.
 * @param board - the board to search.
 * @param folderPath - the path to find.
 * @returns the entity, or nothing when the board has none there.
 */
export function findEntity(board: Board, folderPath: string): Entity | undefined {
  const stack = [...board.campaigns]
  while (stack.length > 0) {
    const entity = stack.pop()!
    if (entity.folderPath === folderPath) return entity
    stack.push(...entity.children)
  }
  return undefined
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/board-read.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the no-inference rule is load-bearing**

In `readEntity`, change the returned `status` to `children.length > 0 && children.every((c) => c.status === 'done') ? 'done' : status`. Re-run. Expected: "counts progress without touching any status" fails, because the mission now reports `done`. Restore — and note that this mutation is exactly the convenience feature the rule exists to keep out.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.json --noEmit`

```bash
git add src/main/board/board-read.ts src/main/board/board-read.spec.ts
git commit -m "feat(board): read the board, and say what could not be read"
```

---

### Task 4: Writing the board

Six operations, each a whole-file rewrite through the schema, atomic. The only file in this plan that writes.

**Files:**
- Create: `src/main/board/board-write.ts`
- Test: `src/main/board/board-write.spec.ts`

**Interfaces:**
- Consumes: `dumpEntity`, `loadEntity`, `EntityFields`, `EntityKind`, `ENTITY_STATUSES` from `./entity-schema`; `slugify`, `uniqueSlug` from `./slug`; `boardRoot`, `folderFor`, `resolveInBoard`, `TRASH_DIR` from `./board-paths`; `readBoard`, `findEntity` from `./board-read`; `writeFileAtomic` from `../atomic-write`.
- Produces:
  ```ts
  export type WriteResult = { ok: true; folderPath: string } | { ok: false; reason: string }
  export function createEntity(project: string, kind: EntityKind, parentFolder: string, name: string): WriteResult
  export function updateEntity(project: string, folderPath: string, patch: Partial<EntityFields>): WriteResult
  export function setStatus(project: string, folderPath: string, status: string): WriteResult
  export function addCriterion(project: string, folderPath: string, text: string): WriteResult
  export function tickCriterion(project: string, folderPath: string, index: number, done: boolean): WriteResult
  export function trashEntity(project: string, folderPath: string): WriteResult
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/board/board-write.spec.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBoard } from './board-read'
import { addCriterion, createEntity, setStatus, tickCriterion, trashEntity, updateEntity } from './board-write'

let project = ''
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dsh-board-'))
  mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/** The YAML on disk for one folder path. */
function read(folderPath: string, kind: string): string {
  return readFileSync(join(project, '.dsh', 'tasks', folderPath, `${kind}.yaml`), 'utf8')
}

describe('createEntity', () => {
  it('creates a campaign from its name', () => {
    const out = createEntity(project, 'campaign', '', 'Q3 Launch')
    expect(out).toEqual({ ok: true, folderPath: 'campaigns/q3-launch' })
    expect(read('campaigns/q3-launch', 'campaign')).toContain('name: Q3 Launch')
    expect(read('campaigns/q3-launch', 'campaign')).toContain('status: draft')
  })

  it('nests a mission and a task under their parents', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const mission = createEntity(project, 'mission', 'campaigns/q3', 'M1 Auth')
    expect(mission).toEqual({ ok: true, folderPath: 'campaigns/q3/missions/m1-auth' })
    const task = createEntity(project, 'task', 'campaigns/q3/missions/m1-auth', 'T1 Login')
    expect(task).toEqual({ ok: true, folderPath: 'campaigns/q3/missions/m1-auth/tasks/t1-login' })
  })

  it('creates a bug under a campaign and under a mission', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(createEntity(project, 'bug', 'campaigns/q3', 'Crash')).toMatchObject({
      folderPath: 'campaigns/q3/bugs/crash',
    })
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    expect(createEntity(project, 'bug', 'campaigns/q3/missions/m1', 'Leak')).toMatchObject({
      folderPath: 'campaigns/q3/missions/m1/bugs/leak',
    })
  })

  // reason: two entities with one name is ordinary, and a create that silently
  // overwrote the first would destroy a plan.
  it('numbers a slug that is already taken rather than overwriting', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(createEntity(project, 'campaign', '', 'Q3')).toEqual({ ok: true, folderPath: 'campaigns/q3-2' })
    expect(readBoard(project).campaigns).toHaveLength(2)
  })

  it('refuses a blank name, which has no slug', () => {
    expect(createEntity(project, 'campaign', '', '   ')).toEqual({ ok: false, reason: 'Name the campaign first.' })
  })

  it('refuses a parent that does not exist', () => {
    expect(createEntity(project, 'mission', 'campaigns/nope', 'M1')).toEqual({
      ok: false,
      reason: 'campaigns/nope is not on the board.',
    })
  })

  it('refuses a parent of the wrong kind', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    expect(createEntity(project, 'mission', 'campaigns/q3/missions/m1', 'M2').ok).toBe(false)
  })
})

describe('updateEntity', () => {
  it('changes the fields it is given and leaves the rest', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(updateEntity(project, 'campaigns/q3', { description: 'ship it' }).ok).toBe(true)
    const text = read('campaigns/q3', 'campaign')
    expect(text).toContain('description: ship it')
    expect(text).toContain('name: Q3')
  })

  // reason: the regression that motivated `extra` upstream — an agent's own
  // key must survive an edit made by something that has never heard of it.
  it('keeps a key the schema does not model', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const file = join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'campaign.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}owner: alice\n`)
    updateEntity(project, 'campaigns/q3', { description: 'changed' })
    expect(read('campaigns/q3', 'campaign')).toContain('owner: alice')
  })

  // reason: the one rule the whole design is defined against.
  it('never changes a parent status when a child is written', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    createEntity(project, 'task', 'campaigns/q3/missions/m1', 'T1')
    setStatus(project, 'campaigns/q3/missions/m1/tasks/t1', 'done')
    const board = readBoard(project)
    expect(board.campaigns[0].status).toBe('draft')
    expect(board.campaigns[0].children[0].status).toBe('draft')
    expect(board.campaigns[0].children[0].progress).toEqual({ done: 1, total: 1 })
  })
})

describe('setStatus', () => {
  it('moves an entity to a status', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(setStatus(project, 'campaigns/q3', 'executing').ok).toBe(true)
    expect(read('campaigns/q3', 'campaign')).toContain('status: executing')
  })

  it('refuses a status the board does not know', () => {
    createEntity(project, 'campaign', '', 'Q3')
    const out = setStatus(project, 'campaigns/q3', 'inprogress')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('draft, executing, awaitingApproval, done, failed, cancelled')
    expect(read('campaigns/q3', 'campaign')).toContain('status: draft')
  })
})

describe('criteria', () => {
  beforeEach(() => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    createEntity(project, 'task', 'campaigns/q3/missions/m1', 'T1')
  })

  it('adds a criterion unticked', () => {
    expect(addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 'it works').ok).toBe(true)
    const text = read('campaigns/q3/missions/m1/tasks/t1', 'task')
    expect(text).toContain('text: it works')
    expect(text).toContain('done: false')
  })

  it('ticks one by position', () => {
    addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 'first')
    addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 'second')
    expect(tickCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 1, true).ok).toBe(true)
    const board = readBoard(project)
    const task = board.campaigns[0].children[0].children[0]
    expect(task.fields.acceptanceCriteria.map((c) => c.done)).toEqual([false, true])
  })

  it('refuses a position that is not there', () => {
    const out = tickCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', 4, true)
    expect(out.ok).toBe(false)
  })

  it('refuses a blank criterion, which cannot be checked', () => {
    expect(addCriterion(project, 'campaigns/q3/missions/m1/tasks/t1', '  ').ok).toBe(false)
  })
})

describe('trashEntity', () => {
  // reason: a board entity carries the plan and the acceptance criteria for
  // real work. A delete recoverable only through git's reflog is one nobody
  // recovers.
  it('moves the folder to the trash rather than removing it', () => {
    createEntity(project, 'campaign', '', 'Q3')
    expect(trashEntity(project, 'campaigns/q3').ok).toBe(true)
    expect(existsSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3'))).toBe(false)
    expect(readBoard(project).campaigns).toEqual([])
    const trashed = join(project, '.dsh', 'tasks', '.trash')
    expect(existsSync(trashed)).toBe(true)
  })

  it('takes the children with it', () => {
    createEntity(project, 'campaign', '', 'Q3')
    createEntity(project, 'mission', 'campaigns/q3', 'M1')
    trashEntity(project, 'campaigns/q3')
    expect(readBoard(project).campaigns).toEqual([])
  })

  // reason: trashing twice is ordinary — two agents, one stale board — and the
  // second must not destroy what the first put there.
  it('does not overwrite an entity already in the trash under that name', () => {
    createEntity(project, 'campaign', '', 'Q3')
    trashEntity(project, 'campaigns/q3')
    createEntity(project, 'campaign', '', 'Q3')
    expect(trashEntity(project, 'campaigns/q3').ok).toBe(true)
    const trash = join(project, '.dsh', 'tasks', '.trash', 'campaigns')
    expect(existsSync(join(trash, 'q3'))).toBe(true)
    expect(existsSync(join(trash, 'q3-2'))).toBe(true)
  })
})

describe('every write', () => {
  // reason: this is the boundary. A folder path arrives from the agent's tools.
  it('refuses a folder path that climbs out of the board', () => {
    expect(setStatus(project, '../../../etc', 'done').ok).toBe(false)
    expect(updateEntity(project, '../..', { name: 'x' }).ok).toBe(false)
    expect(trashEntity(project, '../..').ok).toBe(false)
    expect(createEntity(project, 'mission', '../..', 'M1').ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/board/board-write.spec.ts`
Expected: FAIL — `Failed to resolve import './board-write'`.

- [ ] **Step 3: Implement**

Create `src/main/board/board-write.ts`:

```ts
import { mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../atomic-write'
import { boardRoot, folderFor, resolveInBoard, TRASH_DIR } from './board-paths'
import { findEntity, readBoard } from './board-read'
import { dumpEntity, ENTITY_STATUSES, loadEntity, type EntityFields, type EntityKind } from './entity-schema'
import { slugify, uniqueSlug } from './slug'

/** What one write reports back. */
export type WriteResult = { ok: true; folderPath: string } | { ok: false; reason: string }

/** Which kind may hold which, so a parent of the wrong kind is refused rather than nested. */
const PARENT_OF: Record<EntityKind, EntityKind | undefined> = {
  campaign: undefined,
  mission: 'campaign',
  task: 'mission',
  // A bug is parented by exactly one of a campaign or a mission; checked below.
  bug: undefined,
}

/**
 * Read one entity's file, for a write that is about to rewrite it.
 * @param project - the project's root directory.
 * @param folderPath - the entity's path within the board.
 * @returns the kind, the fields, and the resolved directory — or why not.
 */
function open(
  project: string,
  folderPath: string,
): { ok: true; kind: EntityKind; fields: EntityFields; dir: string } | { ok: false; reason: string } {
  const dir = resolveInBoard(project, folderPath)
  if (dir === undefined) return { ok: false, reason: `${folderPath} is not inside this project's board.` }
  const entity = findEntity(readBoard(project), folderPath)
  if (entity === undefined) return { ok: false, reason: `${folderPath} is not on the board.` }
  return { ok: true, kind: entity.kind, fields: entity.fields, dir }
}

/**
 * Write an entity's file, whole, through the schema.
 *
 * Whole-file rather than a patch, because the schema owns the key order and
 * which keys a kind emits — and because `dumpEntity` re-emits the unmodelled
 * keys it carried in, which a line-level patch could not.
 * @param dir - the entity's directory.
 * @param kind - which `<kind>.yaml` to write.
 * @param fields - the fields to write.
 */
function save(dir: string, kind: EntityKind, fields: EntityFields): void {
  writeFileAtomic(join(dir, `${kind}.yaml`), dumpEntity(kind, fields))
}

/**
 * Create an entity under a parent.
 *
 * The slug comes from the name and is numbered if taken, never reused: two
 * entities with one name is ordinary, and a create that silently overwrote the
 * first would destroy whatever plan it carried.
 * @param project - the project's root directory.
 * @param kind - what to create.
 * @param parentFolder - the parent's folder path; empty for a campaign.
 * @param name - the display name, which the slug is derived from.
 * @returns the new folder path, or why nothing was created.
 */
export function createEntity(project: string, kind: EntityKind, parentFolder: string, name: string): WriteResult {
  if (name.trim() === '') return { ok: false, reason: `Name the ${kind} first.` }
  const board = readBoard(project)
  let parts: string[]
  if (kind === 'campaign') {
    parts = []
  } else {
    if (resolveInBoard(project, parentFolder) === undefined) {
      return { ok: false, reason: `${parentFolder} is not inside this project's board.` }
    }
    const parent = findEntity(board, parentFolder)
    if (parent === undefined) return { ok: false, reason: `${parentFolder} is not on the board.` }
    const wanted = kind === 'bug' ? ['campaign', 'mission'] : [PARENT_OF[kind]]
    if (!wanted.includes(parent.kind)) {
      return { ok: false, reason: `a ${kind} cannot go under a ${parent.kind}.` }
    }
    // The odd segments, not a filter on the words: a campaign legitimately
  // slugged `missions` would otherwise be dropped from its own children's
  // paths. The shape is fixed — campaigns/<c>[/missions/<m>] — so position
  // is what identifies a slug, never its spelling.
  parts = parentFolder.split('/').filter((_, at) => at % 2 === 1)
  }
  const siblingDir = kind === 'campaign' ? 'campaigns' : kind === 'mission' ? 'missions' : kind === 'task' ? 'tasks' : 'bugs'
  const under = kind === 'campaign' ? join(boardRoot(project), 'campaigns') : join(resolveInBoard(project, parentFolder)!, siblingDir)
  let taken: Set<string>
  try {
    taken = new Set(readdirSync(under, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
  } catch {
    taken = new Set()
  }
  const slug = uniqueSlug(slugify(name), taken)
  const folderPath = folderFor(kind, [...parts, slug])
  const dir = resolveInBoard(project, folderPath)
  if (dir === undefined) return { ok: false, reason: `${folderPath} is not inside this project's board.` }
  mkdirSync(dir, { recursive: true })
  save(dir, kind, { name, description: '', acceptanceCriteria: [], documents: [], status: 'draft' })
  return { ok: true, folderPath }
}

/**
 * Change some of an entity's fields, leaving the rest as they are.
 * @param project - the project's root directory.
 * @param folderPath - the entity to change.
 * @param patch - the fields to replace.
 * @returns the folder path, or why nothing changed.
 */
export function updateEntity(project: string, folderPath: string, patch: Partial<EntityFields>): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  save(found.dir, found.kind, { ...found.fields, ...patch })
  return { ok: true, folderPath }
}

/**
 * Move an entity to a status.
 *
 * A status is a claim, and this is where the claim is made. Nothing else in
 * this module writes one — no parent is touched, no child is cascaded to.
 * @param project - the project's root directory.
 * @param folderPath - the entity to move.
 * @param status - one of the six the board knows.
 * @returns the folder path, or why nothing moved.
 */
export function setStatus(project: string, folderPath: string, status: string): WriteResult {
  if (!(ENTITY_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, reason: `"${status}" is not a status. Use one of: ${ENTITY_STATUSES.join(', ')}.` }
  }
  return updateEntity(project, folderPath, { status })
}

/**
 * Add an acceptance criterion, unticked.
 *
 * Unticked always: a criterion created as already met is one nobody checked.
 * @param project - the project's root directory.
 * @param folderPath - the entity to add it to.
 * @param text - what has to be true.
 * @returns the folder path, or why nothing was added.
 */
export function addCriterion(project: string, folderPath: string, text: string): WriteResult {
  if (text.trim() === '') return { ok: false, reason: 'A criterion with no text cannot be checked.' }
  const found = open(project, folderPath)
  if (!found.ok) return found
  const criteria = [...found.fields.acceptanceCriteria, { text: text.trim(), done: false }]
  save(found.dir, found.kind, { ...found.fields, acceptanceCriteria: criteria })
  return { ok: true, folderPath }
}

/**
 * Tick or untick one criterion by its position.
 *
 * By position because that is what a person reading the list sees, and the
 * list is short. A position that is not there is refused rather than ignored:
 * ticking nothing and reporting success is how a gate passes on work that was
 * never done.
 * @param project - the project's root directory.
 * @param folderPath - the entity holding it.
 * @param index - zero-based position in the list.
 * @param done - true to tick, false to clear.
 * @returns the folder path, or why nothing changed.
 */
export function tickCriterion(project: string, folderPath: string, index: number, done: boolean): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  const criteria = found.fields.acceptanceCriteria
  if (!Number.isInteger(index) || index < 0 || index >= criteria.length) {
    return { ok: false, reason: `${folderPath} has ${String(criteria.length)} criteria, so there is none at ${String(index)}.` }
  }
  const next = criteria.map((one, at) => (at === index ? { ...one, done } : one))
  save(found.dir, found.kind, { ...found.fields, acceptanceCriteria: next })
  return { ok: true, folderPath }
}

/**
 * Move an entity, and everything under it, to the board's trash.
 *
 * Never a removal. A board entity carries the plan and the acceptance criteria
 * for real work, and a delete recoverable only through git's reflog is one
 * nobody recovers. The trash keeps the folder's own path under it, so what was
 * deleted is legible without opening anything.
 *
 * A name already in the trash is numbered rather than replaced: trashing twice
 * is ordinary — two agents, one stale board — and the second must not destroy
 * what the first put there.
 * @param project - the project's root directory.
 * @param folderPath - the entity to trash.
 * @returns the folder path, or why nothing was moved.
 */
export function trashEntity(project: string, folderPath: string): WriteResult {
  const found = open(project, folderPath)
  if (!found.ok) return found
  const parent = folderPath.slice(0, folderPath.lastIndexOf('/'))
  const slug = folderPath.slice(folderPath.lastIndexOf('/') + 1)
  const into = join(boardRoot(project), TRASH_DIR, parent)
  mkdirSync(into, { recursive: true })
  let taken: Set<string>
  try {
    taken = new Set(readdirSync(into, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
  } catch {
    taken = new Set()
  }
  renameSync(found.dir, join(into, uniqueSlug(slug, taken)))
  return { ok: true, folderPath }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/board/board-write.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the trash is load-bearing**

Replace `renameSync(...)` with `rmSync(found.dir, { recursive: true, force: true })` and import `rmSync`. Re-run. Expected: both trash tests fail. Restore.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test` and `npx tsc -p tsconfig.json --noEmit`
Expected: everything passes, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/board/board-write.ts src/main/board/board-write.spec.ts
git commit -m "feat(board): create, edit, move status, tick a criterion, trash"
```

---

### Task 5: The agent's tools

Six tools in the MCP server this app already runs. No plugin package, no skill pack — the mechanism exists.

**Files:**
- Modify: `src/main/view-mcp.ts`, `src/main/index.ts`
- Test: `src/main/view-mcp.spec.ts`

**Interfaces:**
- Consumes: everything in `src/main/board/`.
- Produces: `ViewDeps.board`, and six registered tools.

- [ ] **Step 1: Write the failing test**

`src/main/view-mcp.spec.ts` already exists and has the harness you need — use it, do not build a second one. Its shape:

- `deps(overrides)` builds a `ViewDeps` with `roots: () => ['/p/demo']` by default.
- `serve(d, surface)` starts the server and returns its URL; pass `'editor'`.
- `callTool(url, name, args)` calls one tool and returns the result.
- `textOf(result)` joins the result's content.
- A refusal is `result.isError === true` with the reason in `textOf(result)`.

Add these imports at the top of that file: `import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'`, `import { tmpdir } from 'node:os'`, `import { dirname, join } from 'node:path'`.

Add this helper beside the file's existing ones:

```ts
/**
 * A project directory holding a board with the files given.
 *
 * Real directories rather than a mocked filesystem: the board's whole contract
 * is what is on disk, and a test over a fake one would prove nothing about it.
 * @param files - paths within `.dsh/tasks/`, mapped to their contents.
 * @returns the project's root directory.
 */
function boardFixture(files: Record<string, string>): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-mcp-board-'))
  mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
  for (const [path, body] of Object.entries(files)) {
    const full = join(project, '.dsh', 'tasks', path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return project
}
```

Then append the tests:

```ts
describe('the board tools', () => {
  it('offers the six board tools on the editor endpoint', async () => {
    const url = await serve(deps(), 'editor')
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    const names = ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'board_read',
        'board_create',
        'board_update',
        'board_status',
        'board_criterion',
        'board_delete',
      ]),
    )
  })

  // reason: these tools take no path — the open project is the whole of their
  // addressing — so "which project" is the one thing every one must get right.
  it('refuses when no project is open', async () => {
    const url = await serve(deps({ roots: () => [] }), 'editor')
    const result = await callTool(url, 'board_read')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('No project is open')
  })

  // reason: writing a plan into whichever project happened to be first is not
  // a mistake to make on the user's behalf.
  it('refuses to guess between two open projects', async () => {
    const url = await serve(deps({ roots: () => ['/p/one', '/p/two'] }), 'editor')
    expect((await callTool(url, 'board_read')).isError).toBe(true)
  })

  it('says a project has no board rather than creating one', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dsh-mcp-noboard-'))
    const url = await serve(deps({ roots: () => [project] }), 'editor')
    expect(textOf(await callTool(url, 'board_read'))).toContain('no board')
  })

  it('reads a board, with its statuses and folder paths', async () => {
    const project = boardFixture({
      'campaigns/q3/campaign.yaml': 'name: Q3\nstatus: executing\n',
      'campaigns/q3/missions/m1/mission.yaml': 'name: M1\nstatus: draft\n',
    })
    const url = await serve(deps({ roots: () => [project] }), 'editor')
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('Q3')
    expect(text).toContain('executing')
    expect(text).toContain('campaigns/q3/missions/m1')
  })

  it('creates, then reads back what it created', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ roots: () => [project] }), 'editor')
    expect((await callTool(url, 'board_create', { kind: 'campaign', name: 'Q3 Launch' })).isError).toBeFalsy()
    expect(textOf(await callTool(url, 'board_read'))).toContain('Q3 Launch')
  })

  // reason: the status set is fixed, and an agent learns that from the refusal
  // as much as from the description — so the refusal has to carry the list.
  it('names the six statuses when it refuses one', async () => {
    const project = boardFixture({ 'campaigns/q3/campaign.yaml': 'name: Q3\n' })
    const url = await serve(deps({ roots: () => [project] }), 'editor')
    const result = await callTool(url, 'board_status', { folder: 'campaigns/q3', status: 'inprogress' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('awaitingApproval')
  })

  // reason: the one rule the whole design is defined against.
  it('does not move a parent when a child is marked done', async () => {
    const project = boardFixture({
      'campaigns/q3/campaign.yaml': 'name: Q3\nstatus: draft\n',
      'campaigns/q3/missions/m1/mission.yaml': 'name: M1\nstatus: draft\n',
    })
    const url = await serve(deps({ roots: () => [project] }), 'editor')
    await callTool(url, 'board_status', { folder: 'campaigns/q3/missions/m1', status: 'done' })
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('[draft] campaign Q3')
    expect(text).toContain('(1/1 done)')
  })

  // reason: this is the boundary — a folder path from the model becomes a
  // directory this app writes into and moves to the trash.
  it('refuses a folder path that climbs out of the board', async () => {
    const project = boardFixture({ 'campaigns/q3/campaign.yaml': 'name: Q3\n' })
    const url = await serve(deps({ roots: () => [project] }), 'editor')
    expect((await callTool(url, 'board_delete', { folder: '../../..' })).isError).toBe(true)
  })

  it('reports a file it could not read alongside the rest of the board', async () => {
    const project = boardFixture({
      'campaigns/q3/campaign.yaml': 'name: Q3\n',
      'campaigns/q3/missions/m1/mission.yaml': 'name: [unclosed\n',
    })
    const url = await serve(deps({ roots: () => [project] }), 'editor')
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('Q3')
    expect(text).toContain('Could not read')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/view-mcp.spec.ts`
Expected: FAIL — no board tools are registered.

- [ ] **Step 3: Implement the tools**

In `src/main/view-mcp.ts`, add the imports:

```ts
import { readBoard, type Board, type Entity } from './board/board-read'
import { addCriterion, createEntity, setStatus, tickCriterion, trashEntity, updateEntity } from './board/board-write'
import { ENTITY_STATUSES } from './board/entity-schema'
```

Add a helper above `buildServer`:

```ts
/**
 * The project a board tool acts on.
 *
 * The board belongs to one project, and these tools take no path — so the open
 * project is the whole of their addressing. Several open projects is refused
 * rather than guessed: writing a plan into whichever one happened to be first
 * is not a mistake to make on the user's behalf.
 * @param roots - the projects the harness has opened.
 * @returns the project, or why there is not exactly one.
 */
function boardProject(roots: string[]): { ok: true; project: string } | { ok: false; reason: string } {
  if (roots.length === 0) return { ok: false, reason: 'No project is open, so there is no board.' }
  if (roots.length > 1) return { ok: false, reason: 'More than one project is open, so which board is ambiguous.' }
  return { ok: true, project: roots[0] }
}

/**
 * The board as an agent reads it: one line per entity, indented by depth.
 *
 * Lines rather than JSON. An agent reads this to decide what to do next, and
 * an indented list of names with their statuses and progress is what that
 * decision is made from — a nested object costs more tokens to say the same
 * thing and is harder to scan.
 * @param board - the board to render.
 * @returns the text, including findings when there are any.
 */
function renderBoard(board: Board): string {
  if (!board.present) return 'This project has no board. Create a campaign to start one.'
  const lines: string[] = []
  const walk = (entity: Entity, depth: number): void => {
    const progress = entity.progress.total > 0 ? `  (${String(entity.progress.done)}/${String(entity.progress.total)} done)` : ''
    lines.push(`${'  '.repeat(depth)}[${entity.status}] ${entity.kind} ${entity.name}${progress}`)
    lines.push(`${'  '.repeat(depth)}  ${entity.folderPath}`)
    for (const child of entity.children) walk(child, depth + 1)
  }
  for (const campaign of board.campaigns) walk(campaign, 0)
  if (lines.length === 0) lines.push('The board is empty.')
  if (board.findings.length > 0) {
    lines.push('', 'Could not read:')
    for (const finding of board.findings) lines.push(`  ${finding.folderPath}: ${finding.says}`)
  }
  return lines.join('\n')
}
```

Then register the six, inside `buildServer`, in the `if (editor)` group:

```ts
  if (editor) server.registerTool(
    'board_read',
    {
      title: 'Read the project board',
      description:
        "The whole board for the open project: campaigns, their missions, the tasks and bugs under them, each with its status and folder path. The board is YAML files under `.dsh/tasks/`, committed with the code. Read this before planning work, and read it again before claiming any of it is done — someone else may have moved it. Every other board tool addresses an entity by the folder path this returns.",
      inputSchema: {},
    },
    () => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      return done(renderBoard(readBoard(project.project)))
    },
  )

  if (editor) server.registerTool(
    'board_create',
    {
      title: 'Add something to the project board',
      description:
        "Create a campaign, mission, task or bug. A campaign is an outcome; a mission is an independently shippable slice of it; a task is one small verifiable unit; a bug is a defect. A mission goes under a campaign, a task under a mission, and a bug under either. Give `parent` the folder path from board_read — omit it only for a campaign. A task should be given at least one acceptance criterion with board_criterion: a task with no checkable definition of done cannot be gated.",
      inputSchema: {
        kind: z.enum(['campaign', 'mission', 'task', 'bug']).describe('What to create.'),
        name: z.string().describe('The display name. The folder is named after it.'),
        parent: z.string().optional().describe("The parent's folder path from board_read. Omit for a campaign."),
      },
    },
    ({ kind, name, parent }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const out = createEntity(project.project, kind, parent ?? '', name)
      return out.ok ? done(`Created ${out.folderPath}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_update',
    {
      title: 'Edit an entity on the board',
      description:
        "Change an entity's name, description or notes. Notes are free-form prose for decisions, rationale and sign-offs — appended reasoning that outlives the conversation it was decided in. This does not change status: use board_status for that.",
      inputSchema: {
        folder: z.string().describe('The folder path from board_read.'),
        name: z.string().optional().describe('A new display name. The folder does not move.'),
        description: z.string().optional().describe('What this entity is.'),
        notes: z.string().optional().describe('Decisions and rationale, in prose.'),
      },
    },
    ({ folder, name, description, notes }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const patch = { ...(name !== undefined && { name }), ...(description !== undefined && { description }), ...(notes !== undefined && { notes }) }
      if (Object.keys(patch).length === 0) return refuse('Name at least one field to change.')
      const out = updateEntity(project.project, folder, patch)
      return out.ok ? done(`Updated ${folder}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_status',
    {
      title: 'Move an entity to a status',
      description:
        `Set one entity's status to one of: ${ENTITY_STATUSES.join(', ')}. Nothing else changes it — a mission does not become done because its last task did, and a campaign does not start because a mission did. A status is a claim, so make it deliberately, and only for the entity you are actually talking about.`,
      inputSchema: {
        folder: z.string().describe('The folder path from board_read.'),
        status: z.string().describe(`One of: ${ENTITY_STATUSES.join(', ')}.`),
      },
    },
    ({ folder, status }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const out = setStatus(project.project, folder, status)
      return out.ok ? done(`${folder} is now ${status}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_criterion',
    {
      title: 'Add or tick an acceptance criterion',
      description:
        "Add a criterion to an entity, or tick one that is now met. A criterion is a statement that is checkably true or false about observable behaviour — not a description of the work. Give `text` to add one; give `index` and `done` to tick or clear one, where index is its zero-based position in the list board_read shows. Ticking is a claim that you verified it, not that you intended it.",
      inputSchema: {
        folder: z.string().describe('The folder path from board_read.'),
        text: z.string().optional().describe('A new criterion, added unticked.'),
        index: z.number().optional().describe('Zero-based position of the criterion to tick.'),
        done: z.boolean().optional().describe('True to tick it, false to clear it.'),
      },
    },
    ({ folder, text, index, done: ticked }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      if (text !== undefined) {
        const out = addCriterion(project.project, folder, text)
        return out.ok ? done(`Added a criterion to ${folder}.`) : refuse(out.reason)
      }
      if (index === undefined || ticked === undefined) return refuse('Give either text to add one, or index and done to tick one.')
      const out = tickCriterion(project.project, folder, index, ticked)
      return out.ok ? done(`${ticked ? 'Ticked' : 'Cleared'} criterion ${String(index)} on ${folder}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_delete',
    {
      title: 'Move a board entity to the trash',
      description:
        "Move an entity, and everything under it, to `.dsh/tasks/.trash/`. It leaves the board but stays on disk, so a delete made in error is recoverable. Deleting a campaign takes its missions, tasks and bugs with it.",
      inputSchema: { folder: z.string().describe('The folder path from board_read.') },
    },
    ({ folder }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const out = trashEntity(project.project, folder)
      return out.ok ? done(`Moved ${folder} to the board's trash.`) : refuse(out.reason)
    },
  )
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/view-mcp.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test` and `npx tsc -p tsconfig.json --noEmit`
Expected: everything passes, typecheck clean.

- [ ] **Step 6: Prove the project gate is load-bearing**

In `boardProject`, replace the empty-roots branch with `return { ok: true, project: roots[0] ?? '/' }`. Re-run. Expected: "refuses every board tool when no project is open" fails. Restore.

- [ ] **Step 7: Document it**

In `README.md`, in the section describing what the agent can do, add one paragraph in the README's voice:

```markdown
The agent can also keep a board. `.dsh/tasks/` holds campaigns, missions,
tasks and bugs as YAML files, committed alongside the code — so a plan is
diffable, survives the conversation it was made in, and merges when two agents
work on different branches. Nothing infers a status: a mission is done when
someone says so, never because its last task finished.
```

- [ ] **Step 8: Commit**

```bash
git add src/main/view-mcp.ts src/main/view-mcp.spec.ts README.md
git commit -m "feat(board): six tools, so the agent can drive the board"
```

---

## Not in this plan, deliberately

The spec's **watcher** — re-reading when anything under `.dsh/tasks/` changes — is not here, and its absence is a decision rather than an omission. A watcher exists to tell a view that its picture is stale; this plan draws nothing. The tools read the board fresh on every call, which is milliseconds and cannot be stale by construction. The watcher arrives with the views it serves, in the next plan.

## Manual verification

No test here drives a real agent, so this is checked by hand once, in a packaged build (`npm run pack`; quit the running copy from the tray first, or the single-instance lock makes the new build exit immediately):

1. Open a project with no `.dsh/tasks/`. Ask the agent to read the board: it should say there is none, and **create nothing**.
2. Ask it to plan a small piece of work. Check the YAML on disk reads the way you would have written it, and that `git status` shows the new files.
3. Ask it to mark a task done. Confirm the **mission's** status did not move, and that `board_read` shows `(1/2 done)` against it.
4. Hand-edit a `task.yaml` in the editor, adding a key the schema has never heard of. Ask the agent to change the description. Confirm your key survived.
5. Ask it to delete a campaign, then look in `.dsh/tasks/.trash/`.
6. Break a `mission.yaml` deliberately. Confirm `board_read` names it and still reads everything else.
