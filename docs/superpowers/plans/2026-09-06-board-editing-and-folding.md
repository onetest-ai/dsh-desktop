# Board editing, folding, and the tests surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the detail an editor (edit prose inline, add acceptance criteria, attach documents and test links — no markdown editor), fold campaigns and missions, fix the test-click so it opens the test's detail, and redraw the tests surface so it reads well.

**Architecture:** The store already performs every write this needs — `updateEntity` (prose fields), `addCriterion`, `linkTest`. The work is (1) exposing those over the bridge/IPC the way `tasks:set-status` and `tasks:tick` already are, and carrying `documents` on the detail wire; (2) a pure inline-edit field module ported from octoshell's `Field`/`ChecklistField` (click to edit → autosizing textarea → save on blur), which the renderer must not import from main; (3) wiring editing into `board-detail.ts`; (4) per-session fold state in `board.ts`; (5) a reveal fix and a tests-list redesign. Every write is followed by the board's existing re-read-from-disk redraw — no optimistic local state, consistent with the store's rule that the files are the truth.

**Tech Stack:** TypeScript (renderer under `tsconfig.pane.json`, `.ts` import suffixes; main under `tsconfig.json`), Electron IPC, Vitest + jsdom.

**Spec:** `docs/notes/task-board-views.md` (views) and `docs/notes/task-board.md` (store) are binding. Both were amended by earlier plans; read the current text. Where a task changes behaviour the spec describes, the spec is updated in Task 8.

## Global Constraints

- **The renderer never imports from `src/main/`.** `tsconfig.pane.json` compiles `src/renderer/pane/**` separately. Renderer imports carry a `.ts` suffix; main imports do not. Wire types (`EntityDetailView` in `bridge.ts` / `EntityDetailWire` in `board-ipc.ts`) are declared on both sides deliberately — keep the two in sync by hand; nothing compiles them against each other.
- **Every write goes through the store**, which gates every agent-/renderer-supplied path through `resolveInBoard` and writes atomically. No renderer or IPC handler may touch the filesystem directly or bypass `resolveInBoard`. Do not weaken any security test; `trashEntity` keeps its resolved-destination check.
- **After a write, the board re-reads from disk and redraws.** Do not hold an optimistic edited copy as the source of truth; a field shows what the last read returned, and a refusal leaves the file unchanged. This is the store's existing rule (`board-ipc.ts` re-reads on every change).
- **No formatter is configured.** Never run `prettier`, `eslint --fix`, or any formatter. `board.ts` / `board-detail.ts` doc comments argue their decisions rather than restating the code — write in that voice.
- **Colour is a design token** (`--dsw-alias-*` / `--ds-*`), never a literal, and never `currentColor` as a colour choice (allowed only inside an SVG glyph shape). The accent is `--dsw-alias-state-business-primary`.
- **Never `git add -A`, `git add .`, or `git commit -a`.** The repo root holds untracked `index.js` and `tree-menu.js` belonging to the user that must never be committed. Stage only the files you changed.
- Tests must be non-vacuous — break the code under a new test and confirm it fails.
- The suite is green at 2121 tests. Run `npx vitest run`, `npx tsc -p tsconfig.json --noEmit`, and `npx tsc -p tsconfig.pane.json --noEmit` before each commit; all must stay green.
- Do not touch the create modal, the drag-and-drop path, or `src/main/board/**` (the store is finished; these tasks read and call it, they do not extend it) — with ONE permitted exception: Task 1 may add a single small pure exported helper to `entity-schema.ts` that maps a section heading to the `EntityFields` field it patches (`patchForSection(level, heading, body)`), with its own non-vacuous test. Schema knowledge belongs in the schema; scattering a heading→field table into `index.ts` would be the worse choice. Nothing else in `board/` changes.

---

### Task 1: The editing seams — bridge, IPC, and documents on the wire

**Files:**
- Modify: `src/main/board-ipc.ts` (add `documents` to `EntityDetailWire` and `detailFor`), `src/main/board-ipc.spec.ts`
- Modify: `src/main/index.ts` (three new IPC handlers beside `tasks:tick` at ~line 2755), `src/main/index.spec.ts`
- Modify: `src/renderer/pane/bridge.ts` (mirror the wire field and add three methods + preload)

**Interfaces:**
- Produces on `window.pane`: `updateBoardEntity(folderPath: string, patch: { description?: string; notes?: string; sections?: { heading: string; body: string }[] }): Promise<BoardResult>`; `addBoardCriterion(folderPath: string, text: string): Promise<BoardResult>`; `linkBoardTest(folderPath: string, test: string, comment: string): Promise<BoardResult>`.
- `EntityDetailWire` / `EntityDetailView` gain `documents: { label: string; target: string }[]`.

- [ ] **Step 1: Write the failing tests**

- `board-ipc.spec.ts`: `detailFor` on a campaign/mission with a `## documents`-backed `documents` field carries them as `{label,target}` in `documents`; a level with none carries `[]`.
- `index.spec.ts` (fake IPC, mirroring the `tasks:tick` test ~line 2755): `tasks:update` with a `{description}` patch writes it and returns `{ok:true}`; `tasks:add-criterion` appends a criterion; `tasks:link` records a test link; each refuses a path outside the board with `{ok:false}` (parity with `tasks:tick`'s path-refusal test).

- [ ] **Step 2: Run, fail**

Run: `npx vitest run src/main/board-ipc.spec.ts src/main/index.spec.ts`

- [ ] **Step 3: Implement**

- `board-ipc.ts`: add `documents` to `EntityDetailWire` and populate it in `detailFor` from the entity's `fields.documents` (already parsed by the store as `{label,target}`). For a level with no documents, `[]`.
- `index.ts`, beside `tasks:tick`:
  - `tasks:update` receives `{folderPath, patch}` where `patch` is `{description?, notes?, section?: {heading, body}}`. `description` and `notes` map straight to `EntityFields`. A `section` is translated to its field via the new `patchForSection(level, heading, body)` helper (the handler reads the entity's level from the store to know it), producing a `Partial<EntityFields>` handed to `updateEntity`. `updateEntity(project, folderPath, patch)` is `Partial<EntityFields>` (board-write.ts:242).
  - `ipcMain.handle('tasks:add-criterion', (_e, folderPath: string, text: string) => addCriterion(currentProject?.path ?? '', folderPath, text))`.
  - `ipcMain.handle('tasks:link', (_e, folderPath: string, test: string, comment: string) => linkTest(currentProject?.path ?? '', folderPath, test, 'not_run', comment))` — `linkTest(project, folderPath, test, result, comment, bug?)` (board-write.ts:427); a freshly attached test is `not_run` (it has not been run against this workitem yet), and the store refuses a non-workitem level and an unknown test path already.
  - Each returns the store's `WriteResult`; the store owns `resolveInBoard`, so the handler adds no path logic.
- `bridge.ts`: add `documents` to `EntityDetailView`; add the three methods to the `window.pane` type and their preload `invoke` implementations, exactly as `tickCriterion` is done.

- [ ] **Step 4: Run everything, typecheck both configs, commit**

```bash
npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add src/main/board-ipc.ts src/main/board-ipc.spec.ts src/main/index.ts src/main/index.spec.ts src/renderer/pane/bridge.ts
git commit -m "feat(board): editing seams — update a field, add a criterion, link a test"
```

---

### Task 2: The inline-edit field

**Files:**
- Create: `src/renderer/pane/edit-field.ts`, `src/renderer/pane/edit-field.spec.ts`

**Interfaces:**
- Produces: `editField(opts: { value: string; placeholder: string; onSave: (next: string) => void; multiline?: boolean }): HTMLElement` — a control that shows `value` as read text until clicked, then becomes an autosizing textarea that calls `onSave` on blur only when the value changed, and reverts to read text.

- [ ] **Step 1: Write the failing tests** (jsdom)

- renders the value as read text initially (a `.edit-field-read` element carrying the text);
- clicking it swaps to a `<textarea>` carrying the same value, focused;
- editing and blurring calls `onSave` once with the new value;
- blurring with no change does NOT call `onSave`;
- an empty value shows the placeholder as muted read text, and clicking it still opens an empty textarea;
- Escape reverts without calling `onSave` (optional but tested if implemented).

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

Port octoshell's `Field` + `AutoTextarea` (at `/Users/arozumenko/Development/octoshell/apps/vscode-extension/src/webview/field.tsx` and `checklist-field.tsx`) to a framework-free element: a read `<div>`/`<button>` that on click replaces itself with a `<textarea>` sized to its content (`scrollHeight`), saving on blur when changed. No colour literals; classes only (`.edit-field`, `.edit-field-read`, `.edit-field-input`, styled in Task 3's CSS or Task 6). JSDoc in the house voice.

- [ ] **Step 4: Prove non-vacuous, typecheck, commit**

Break the change-check (always call `onSave`); confirm the no-change test fails; restore.

```bash
npx vitest run src/renderer/pane/edit-field.spec.ts && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/edit-field.ts src/renderer/pane/edit-field.spec.ts
git commit -m "feat(board): an inline field that edits in place and saves on blur"
```

---

### Task 3: The detail becomes an editor

**Files:**
- Modify: `src/renderer/pane/board-detail.ts`, `src/renderer/pane/board-detail.spec.ts`
- Modify: `src/renderer/pane.css` (styles for the edit field, the add-criterion control, the documents section)

**Interfaces:**
- Consumes: `editField` from `./edit-field.ts`; the three new `window.pane` methods via new `DetailActions` callbacks.
- `DetailActions` gains: `edit(folderPath, patch)`, `addCriterion(folderPath, text)`, `attachDoc(folderPath, label, target)` (or `linkTest` for a workitem's test link — name it per what it calls).

- [ ] **Step 1: Write the failing tests** (jsdom, against a fixture `EntityDetailView`)

- the description renders as an `editField`; saving it calls `on.edit` with `{description: <new>}`;
- each non-stray prose section (a task's/mission's `Notes`, a bug's `Steps to Reproduce`, a test's `Steps`/`Preconditions`/…) renders as an `editField`; saving calls `on.edit` with `{sections: [{heading, body}]}` (or the matching field);
- a **stray** section stays read-only with its finding (editing malformed data in place would write it back as if it belonged);
- Acceptance Criteria shows an "Add" control that calls `on.addCriterion` with the typed text; existing criteria keep their tick checkboxes;
- a campaign/mission renders its `documents` and an "Attach" control that calls `on.attachDoc`;
- a workitem renders an "Add test" control on its Validated-by list that calls the link action;
- a test's detail is editable in the same way for its own sections; a test has no status and no criteria (unchanged).

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

- Replace the read-only `prose` render for description and each **non-stray** modelled section with `editField`, wired to `on.edit`. Keep `renderMarkdown` for display when NOT editing is not required — octoshell shows the raw text in the textarea and the saved markdown renders on redraw; simplest is: read state shows rendered markdown (as today), click enters a textarea with the raw section body, save writes it and the board re-reads. Decide and document: the read state may show rendered markdown while the edit state shows raw — that is octoshell's behaviour and it is fine.
- Acceptance Criteria: keep the checkbox list; add an input + button (or an editField in "add" mode) that calls `on.addCriterion`.
- Documents: render the `documents` list; add an attach control (two small inputs, label + target, or a single control) calling `on.attachDoc`.
- Validated-by (workitem): add an "Add test" control calling the link action.
- Wire the new `DetailActions` in `board.ts` to the three `window.pane` methods, each followed by the existing re-read (the board already redraws on `tasks:changed`; a write returning a refusal shows it inline without losing the edit).

- [ ] **Step 4: CSS**

Style `.edit-field-read` (looks like text, a subtle hover affordance so it reads as editable), `.edit-field-input` (a real textarea on `bg-layer-1`, `border-l2`, focus ring in the accent), the add/attach controls (quiet, consistent with the modal's inputs). Tokens only.

- [ ] **Step 5: Prove non-vacuous, run, commit**

Break the stray-section guard (make a stray section editable); confirm the read-only-stray test fails; restore.

```bash
npx vitest run && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/board-detail.ts src/renderer/pane/board-detail.spec.ts src/renderer/pane.css
git commit -m "feat(board): edit prose, add criteria, and attach links in the detail"
```

---

### Task 4: Campaigns and missions fold

**Files:**
- Modify: `src/renderer/pane/board.ts`, `src/renderer/pane/board.spec.ts`, `src/renderer/pane.css`

The spec (`docs/notes/task-board-views.md`, "The board" and "What the view remembers") already describes folding as intended: both missions and campaigns fold, folding is per-view and per-session (a posture, not persisted), keyed by folder path and cleared on project change. Build that.

- [ ] **Step 1: Write the failing tests** (jsdom)

- a campaign heading is a control; activating it collapses its lanes (they leave the DOM or are hidden) and a folded campaign still shows its name and a folded affordance (a chevron/marker);
- a mission lane header is a control; activating it collapses that lane's columns while keeping the lane's title, status glyph, and add control;
- fold state is per folder path: folding one campaign does not fold another;
- a redraw (a `tasks:changed`) preserves the fold state (it lives in module state, not the DOM);
- a project change clears fold state (beside where `refusal`/`revealed`/`place` are cleared).

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement**

- Add module state `const folded = new Set<string>()` (folder paths of collapsed campaigns and missions). A campaign heading and a mission lane header get a click handler toggling their path in `folded` and calling `draw()`.
- In `draw()`/`groupBoard` rendering: a folded campaign draws its heading with a collapsed marker and skips its lanes; a folded mission draws its header and skips its columns.
- Draw a chevron/disclosure marker (an SVG or a CSS triangle, tokened) that rotates with state; the header is a real button for keyboard reach.
- Clear `folded` on project change, beside `refusal`/`revealed`/`place`.
- Do not touch the reveal: a reveal must unfold whatever it lands in (the spec says "a reveal unfolds and unhides whatever it has to") — when `onReveal` names a card in a folded lane/campaign, remove those paths from `folded` before drawing so the target is visible.

- [ ] **Step 4: CSS, run, commit**

Style the fold header (cursor, hover, the chevron rotation). Tokens only.

```bash
npx vitest run && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/board.ts src/renderer/pane/board.spec.ts src/renderer/pane.css
git commit -m "feat(board): fold a campaign or a mission, per session"
```

---

### Task 5: The test click, and the tests surface

**Files:**
- Modify: `src/renderer/pane/board.ts` (the reveal fix and `drawTests`/`testRow`/suite render), `src/renderer/pane/board.spec.ts`
- Modify: `src/renderer/pane.css` (the tests list)
- Possibly: `src/main/index.ts` `tasks:reveal` relay (only if the reveal is dropped there — diagnose first)

- [ ] **Step 1: Diagnose the test-click, then write the failing test**

Clicking a test in the side tree calls `revealOnBoard(test.folderPath)`; `board.ts`'s `onReveal` is supposed to open the test's detail (`isTest(latest?.tests, folderPath)` → `openDetail`). On the running app it does not show the test. Write a jsdom test that drives the pane's `onReveal` with a test's folder path (against a `latest` that contains that test in `tests`) and asserts the detail renders for it. Run it:
- if it FAILS, the bug is in the pane (`isTest` match, or `latest.tests` shape, or `openDetail`) — fix it there and keep the test.
- if it PASSES, the bug is upstream: the tree→main→pane relay (`tasks:reveal` in `index.ts`, or the tree's `TestView.folderPath` differing from the board's). Trace `tasks:reveal`'s handler and the two folder-path sources; add a test at the seam that is actually broken. Record in your report which it was.

- [ ] **Step 2: The tests layout**

Rework `drawTests` / the suite render / `testRow` and their CSS so the Tests destination reads well:
- suites as quiet headings with their nesting shown by indent and a rule (as the board's groups are);
- a test row: the name, its verdict dot + `pass/total` count aligned to the right on a tabular column, hover affordance, a hairline between rows;
- an empty suite or an empty tests root gets a worded empty state, not a bare gap;
- match the board's density and token vocabulary. This is the part the user called "much better", so make it a real layout, not a list of `<li>`.

- [ ] **Step 3: Run, prove non-vacuous, commit**

Break the reveal fix (or the seam fix) and confirm the new test fails; restore.

```bash
npx vitest run && npx tsc -p tsconfig.pane.json --noEmit && npx tsc -p tsconfig.json --noEmit
git add src/renderer/pane/board.ts src/renderer/pane/board.spec.ts src/renderer/pane.css src/main/index.ts src/main/index.spec.ts
git commit -m "feat(board): a test opens its detail, and the tests list reads like one"
```

---

### Task 6: See it, and reconcile the spec

**Files:**
- Modify: `src/renderer/pane.css` (fixes from looking)
- Modify: `docs/notes/task-board-views.md`

- [ ] **Step 1: Build and look**

```bash
npm run build && npx electron-builder --dir -c.mac.identity=null
```

Quit any running copy from the tray first (single-instance lock). Open a project with a board and, in **both light and dark**, check: cards read as surfaces on the dark tray (Task fix already shipped); a card's detail edits a field inline and saves; adding a criterion and attaching a link work; a campaign and a mission fold and unfold; clicking a test in the side tree opens its detail; the Tests destination reads as a real layout. **Judge the render; do not describe the source.** Fix what is wrong in `pane.css`; record what you changed and why.

If the packaged window cannot be screenshotted in this environment, say so plainly and serve the built `dist/renderer` with a real board's data instead — do not fabricate having seen it. The parent (controller) also owns a visual pass.

- [ ] **Step 2: Reconcile the spec**

Update `docs/notes/task-board-views.md` where behaviour changed: the detail is now editable (prose inline, add criteria, attach links) — its "Deliberately not editable here" section is now wrong and must be rewritten to say what IS editable and what still is not (renames, creating campaigns/missions, arbitrary new sections); folding is now real; the tests list is a described layout. Voice: argue, don't list. Change only what changed.

- [ ] **Step 3: Run everything and commit**

```bash
npx vitest run && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane.css docs/notes/task-board-views.md
git commit -m "feat(board): the design pass and the spec that describes it"
```
