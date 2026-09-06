# Board representation pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the task board *read as a board* — a Linear-grade status-glyph system, quiet cards with a mono slug line and dot-chips, hairline separation instead of boxed cards, and a detail that sits on the bare canvas at a readable measure — without changing what anything does.

**Architecture:** Pure representation. No store, no IPC, no data shape changes. The work is a new pure status-glyph module on the renderer side, small render additions in `board.ts` and `board-detail.ts`, and a rewrite of the board/detail/tests sections of `pane.css`. Every colour is an existing `--dsw-alias-*` token, so both themes come for free.

**Tech Stack:** TypeScript (renderer, `tsconfig.pane.json`, `.ts` import suffixes), inline SVG, Vitest + jsdom.

**Spec / research basis:** `docs/notes/task-board-views.md` is the binding spec for behaviour and must not be contradicted. The visual direction is a Refero reference lock, recorded in the Design Lock below. This plan changes appearance only; where the spec describes a behaviour, that behaviour stays.

## Global Constraints

- **The renderer never imports from `src/main/`.** `tsconfig.pane.json` compiles `src/renderer/pane/**` separately. Renderer imports carry a `.ts` suffix.
- **No formatter is configured.** Never run `prettier`, `eslint --fix`, or any formatter. `board.ts` and `board-detail.ts` doc comments argue for their decisions rather than restating the code — write in that voice.
- **Colour is a token, never a literal.** Every colour must be an existing `--dsw-alias-*` token (enumerated in the Design Lock). No hex, no `rgb()`, no `currentColor` as a colour choice. If a rule needs a token that does not exist, that is a finding to raise, not a hex to inline.
- **Never `git add -A`, `git add .`, or `git commit -a`.** The repo root holds untracked `index.js` and `tree-menu.js` belonging to the user that must never be committed. Stage only the files you changed.
- Tests must be non-vacuous — break the code under a new test and confirm it fails.
- The suite is green at 2106 tests. Run `npx vitest run` and `npx tsc -p tsconfig.pane.json --noEmit` before each commit; both must stay green.
- Do not touch the create modal, the drag-and-drop path, the reveal, or `src/main/**`. This is appearance only.

## Design Lock (Refero reference lock — do not average away)

Primary reference: **Linear** (board + issue detail). Borrowed: **shadcn/ui** light-monochrome discipline. The app ships light+dark via its own tokens, so neither reference's canvas colour is used — token roles are preserved.

**The signature move — the status glyph.** A small circular glyph encodes the five statuses by how full it is, drawn beside the status *everywhere* (column header, detail header, detail status field, and any status pill). It is semantic, so it is allowed where a decorative stripe would not be.

| Status | Glyph | Colour token |
|--------|-------|--------------|
| idea | dotted/hollow ring | `--dsw-alias-label-tertiary` |
| backlog | solid ring, empty centre | `--dsw-alias-label-secondary` |
| executing | ring with a ~50% accent arc | `--dsw-alias-state-business-primary` |
| validation | ring with a ~85% accent arc | `--dsw-alias-state-business-primary` |
| done | filled disc with a check | `--dsw-alias-state-success-primary` |
| (unknown) | hollow ring, dashed | `--dsw-alias-state-warn-primary` |

Colour enters only when work is live (accent) or proven (green) or malformed (amber). idea/backlog stay neutral grey. This is the reuse-the-app's-accent decision: the accent is `--dsw-alias-state-business-primary`.

**Verdict dot** (tests, and the card chip): a filled dot in `--dsw-alias-state-success-primary` when all pass, `--dsw-alias-state-error-primary` when any fail, `--dsw-alias-label-tertiary` when nothing is run, followed by a neutral `pass/total` count in `--dsw-alias-label-secondary`. Colour lives in the dot; the number stays quiet.

**Token roles (the only colours in play):**
- text: `--dsw-alias-label-primary` (title), `--dsw-alias-label-secondary` (body/secondary), `--dsw-alias-label-tertiary` (slug, counts, muted)
- accent (app's own): `--dsw-alias-state-business-primary` — executing/validation glyph, the reveal ring, focus
- semantic: `--dsw-alias-state-success-primary` (done, pass), `--dsw-alias-state-error-primary` (fail, bug), `--dsw-alias-state-warn-primary` (unknown status / malformed)
- hairlines: `--dsw-alias-border-l1` (between cards, section rules), `--dsw-alias-border-l2` (stronger dividers)
- surfaces: `--dsw-alias-bg-overlay` (the column tray only), `--dsw-alias-bg-layer-1/2` (raised chrome), `--dsw-alias-interactive-bg-hover` (hover)

**Phantom tokens to remove.** The current CSS references `--dsw-alias-interactive-primary`, `--dsw-alias-border-primary`, and `--dsw-alias-surface-primary`, none of which exist — each silently falls back to the `, currentColor` / `, transparent` second argument. Replace every one with a real token from the list above. A `var(--real-token)` with no fallback is correct; a fallback to `currentColor` for a colour is a defect.

**Rejected (anti-slop):** boxed bordered cards as the default container; colour used for anything but status/verdict/type; Linear's own indigo (`#6366f1`/`#8b5cf6` — decorative-only there, never promoted to UI here); a left accent stripe as decoration.

---

### Task 1: The status glyph and verdict dot

**Files:**
- Create: `src/renderer/pane/status-glyph.ts`
- Test: `src/renderer/pane/status-glyph.spec.ts`

**Interfaces:**
- Consumes: `BOARD_STATUSES` from `./board-rows.ts` (the five, in order).
- Produces: `statusGlyph(status: string): SVGSVGElement` and `verdictDot(pass: number, total: number): SVGSVGElement`.

- [ ] **Step 1: Write the failing tests**

`status-glyph.spec.ts` (jsdom), asserting on structure and the token class, not pixels:

```ts
import { describe, expect, it } from 'vitest'
import { statusGlyph, verdictDot } from './status-glyph'

describe('statusGlyph', () => {
  it('returns an svg carrying the status as a data attribute, for each of the five', () => {
    for (const s of ['idea', 'backlog', 'executing', 'validation', 'done']) {
      const g = statusGlyph(s)
      expect(g.tagName.toLowerCase()).toBe('svg')
      expect(g.dataset.status).toBe(s)
      expect(g.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('marks an unknown status apart, so a finding does not draw as a real state', () => {
    expect(statusGlyph('weird').dataset.status).toBe('unknown')
  })

  it('fills done with the success token and executing with the accent token', () => {
    // the fill/stroke is set via a CSS custom prop or class the stylesheet keys on,
    // never a literal — assert the class the sheet targets, not a colour.
    expect(statusGlyph('done').getAttribute('class')).toContain('status-glyph')
    expect(statusGlyph('done').classList.contains('status-glyph-done')).toBe(true)
    expect(statusGlyph('executing').classList.contains('status-glyph-executing')).toBe(true)
  })
})

describe('verdictDot', () => {
  it('is green when all pass, red when any fail, neutral when none run', () => {
    expect(verdictDot(3, 3).classList.contains('verdict-dot-pass')).toBe(true)
    expect(verdictDot(2, 3).classList.contains('verdict-dot-fail')).toBe(true)
    expect(verdictDot(0, 0).classList.contains('verdict-dot-none')).toBe(true)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/renderer/pane/status-glyph.spec.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

- Build each glyph as an inline SVG (`document.createElementNS('http://www.w3.org/2000/svg', …)`), 14×14, `aria-hidden="true"`, `dataset.status` = the status or `'unknown'`, class `status-glyph status-glyph-<status>`.
- The shape encodes the state: idea a dashed ring, backlog a solid ring, executing a ring plus a ~50% arc/wedge, validation a ~85% arc, done a filled circle with a check path, unknown a dashed ring. Use `stroke`/`fill` of `currentColor` **for the shape** and let the stylesheet set `color` per `.status-glyph-<status>` from a token — that keeps the colour in CSS/tokens, not in the TS. (currentColor here is a plumbing choice inside an icon, not a UI colour decision — the real colour is the token the class sets.)
- `verdictDot(pass,total)`: a 8×8 filled `<circle>`, class `verdict-dot verdict-dot-<pass|fail|none>` where none = total 0, fail = pass<total, pass otherwise.
- JSDoc every export in the house voice: what the glyph says and why it is drawn, not how the arc is computed.

- [ ] **Step 4: Run and typecheck**

Run: `npx vitest run src/renderer/pane/status-glyph.spec.ts && npx tsc -p tsconfig.pane.json --noEmit` → PASS, clean.

- [ ] **Step 5: Prove non-vacuous**

Make `statusGlyph` ignore its argument (always `'idea'`); confirm the five-status test and the unknown test fail; restore.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/pane/status-glyph.ts src/renderer/pane/status-glyph.spec.ts
git commit -m "feat(board): a status glyph that says which state the work is in"
```

---

### Task 2: Glyphs and dot-chips on the board

**Files:**
- Modify: `src/renderer/pane/board.ts`, `src/renderer/pane/board.spec.ts`

**Interfaces:**
- Consumes: `statusGlyph`, `verdictDot` from `./status-glyph.ts`.
- Produces: no signature changes.

- [ ] **Step 1: Write the failing tests** (in `board.spec.ts`, jsdom)

- every column heading contains a `.status-glyph` whose `data-status` matches the column, before the label text;
- a card whose folder path has a slug shows a `.board-card-slug` line carrying the last path segment, above the name;
- the card's validation chip renders a `.verdict-dot` (green/red/neutral per the verdicts), not a bare coloured word;
- a bug card still shows its type tag;
- the lane status tag renders a `.status-glyph` beside its label (the lane already renders `statusLabel`).

- [ ] **Step 2: Run, fail**

Run: `npx vitest run src/renderer/pane/board.spec.ts`

- [ ] **Step 3: Implement**

- Column header (`columnFor`): prepend `statusGlyph(status)` before the title text; keep `statusLabel(status)` as the text and add the count already available. The column title stops being lowercase raw — it is glyph + Label.
- Card (`cardFor`): add a `.board-card-slug` element carrying the final segment of `entity.folderPath` (the slug), placed above `.board-card-name`. Keep the name. Replace the `chipOf` text chip with `verdictDot(pass,total)` + a neutral count span; the failing state is the dot's colour now, so `.board-chip-failing` is no longer how failure is shown on a card (leave the class if the detail still uses it — check).
- Lane status tag (`laneFor`): prepend `statusGlyph(lane.status)`.
- Touch nothing else — not drag, not reveal, not the modal.

- [ ] **Step 4: Run everything**

Run: `npx vitest run && npx tsc -p tsconfig.pane.json --noEmit` → green.

- [ ] **Step 5: Prove non-vacuous**

Remove the `statusGlyph` prepend from `columnFor`; confirm the column-glyph test fails; restore.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/pane/board.ts src/renderer/pane/board.spec.ts
git commit -m "feat(board): status glyphs on columns and lanes, a slug and a verdict dot on cards"
```

---

### Task 3: The glyph in the detail

**Files:**
- Modify: `src/renderer/pane/board-detail.ts`, `src/renderer/pane/board-detail.spec.ts`

- [ ] **Step 1: Write the failing tests**

- the detail header renders a `.status-glyph` matching `detail.status` beside the title (when the entity has a status);
- the status `<select>` field renders a `.status-glyph` beside its label reflecting the current value;
- a link/child row that carries a status shows its glyph;
- a test's detail (no status) renders no header glyph and does not throw.

- [ ] **Step 2: Run, fail, implement**

- In `renderHeader` (the `board-detail-status` tag around line 198), prepend `statusGlyph(detail.status)` when `detail.status !== ''`.
- In `statusField`, put a `statusGlyph` beside the label that updates on change is not required — a static glyph for the current value is enough; keep it simple and re-render on redraw.
- In the child/link `row(...)` helper, if the row carries a status, prepend its glyph.
- Import from `./status-glyph.ts`.

- [ ] **Step 3: Run everything and commit**

```bash
npx vitest run && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/board-detail.ts src/renderer/pane/board-detail.spec.ts
git commit -m "feat(board): the detail wears the same status glyph as the board"
```

---

### Task 4: The stylesheet — the actual look

**Files:**
- Modify: `src/renderer/pane.css`
- Modify: `src/renderer/pane/board.spec.ts` or a small `board-css.spec.ts` for the CSS-read assertions (jsdom lays nothing out, so pin the rules by reading the file, the way the modal-backdrop precedent in this repo does)

This is the design pass. Every rule below cites a token from the Design Lock.

- [ ] **Step 1: Write the CSS-read tests first**

Read `src/renderer/pane.css` from disk and assert:
- `pane.css` contains **no** `--dsw-alias-interactive-primary`, no `--dsw-alias-border-primary`, no `--dsw-alias-surface-primary` (the phantom tokens are gone);
- `.board-card` no longer sets a `1px solid` border as its default (hairline separation instead) — assert the rule does not contain `border: 1px solid`;
- `.status-glyph-done` sets `color: var(--dsw-alias-state-success-primary)` and `.status-glyph-executing` sets `color: var(--dsw-alias-state-business-primary)`;
- `.board-card-revealed` uses `--dsw-alias-state-business-primary` (not `currentColor`);
- `.board-detail-prose` sets a `max-width` (the capped measure).

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Rewrite the board/detail/tests CSS**

Work through `pane.css` lines ~1156–1710:
- **Column tray** keeps `--dsw-alias-bg-overlay`; widen `.board-column` from 140px to ~168px so a two-line name and a slug fit without truncating most real titles.
- **Column title** becomes a flex row: glyph + `statusLabel` (in `--dsw-alias-label-secondary`, 12px, weight 510) + count (`--dsw-alias-label-tertiary`, tabular). Not lowercase.
- **Cards**: drop the full border and surface fill. A card is separated from its neighbour by a `--dsw-alias-border-l1` hairline (e.g. a bottom border, or a gap on the tray). Hover is `--dsw-alias-interactive-bg-hover`. Radius 6px. Padding 6px 8px.
- **`.board-card-slug`**: 10px, `--dsw-alias-label-tertiary`, the mono family `var(--ds-font-family-code)` (already used for code in this sheet at lines 236 and 1087), letter-spacing to match. Above the name.
- **`.board-card-name`**: `--dsw-alias-label-primary`, 13px, weight 500, the two-line clamp stays.
- **`.status-glyph`**: `width/height: 14px; flex: none;` and one rule per `.status-glyph-<status>` setting `color:` to the Design Lock token. **`.verdict-dot`** likewise, 8px, per-state colour.
- **`.board-detail`**: content on the bare canvas. `.board-detail-prose` gets `max-width: 68ch`. Headings, fields, criteria at a readable rhythm. Keep the table `overflow-x`.
- **`.board-detail-head`**: title (glyph + name, `label-primary`, ~20px weight 510), the file button quiet.
- **`.board-tests`**: suite headings quiet; a test row is glyph-free (tests have no status) but carries a `.verdict-dot` + count. Hairline rows, hover `interactive-bg-hover`.
- Replace every phantom token and every `, currentColor` colour fallback with a real token.

- [ ] **Step 4: Run the suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.pane.json --noEmit && npx tsc -p tsconfig.json --noEmit` → green.

- [ ] **Step 5: SEE IT — the design pass is not optional**

```bash
npm run build && npx electron-builder --dir -c.mac.identity=null
```

Quit any running copy from the tray first (single-instance lock). Open a project with a board; look at the board, a card's detail, and the Tests destination, in **both light and dark**. This repo has a standing rule that a design pass must be *seen*: a previous pass signed off CSS that looked bad on screen. If a packaged screenshot is not possible in this environment, serve the built `dist/renderer` with the real `pane.css` and a real board's data and look at that — and say plainly in the report which you did. Judge the render; fix what is wrong in `pane.css` and record what you changed and why, including anything left deliberately.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/pane.css src/renderer/pane/board.spec.ts
git commit -m "feat(board): the board reads as a board — glyphs, hairlines, a readable detail"
```

---

### Task 5: Reconcile the spec

**Files:**
- Modify: `docs/notes/task-board-views.md`

- [ ] **Step 1**: The views spec describes what a card and a column show. Where this pass changed *what is shown* (a status glyph beside every status; a slug line on a card; a verdict dot rather than a `N/N passing` text chip), update the spec's "What a card shows" and "The board" sections to match, in the file's voice, which argues rather than lists. Where the spec is still true, change nothing. Do not describe CSS; describe what the reader sees and why.

- [ ] **Step 2: Commit**

```bash
git add docs/notes/task-board-views.md
git commit -m "docs(board): the views spec describes the glyph, the slug, and the verdict dot"
```
