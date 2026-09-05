# The task board's two views

The board from `docs/notes/task-board.md` becomes visible: a tree of the hierarchy in the side column, and a swimlane board in the content panel. Both read the same files, both listen for the same change, and neither holds a copy of the truth.

This is the second half of the board. The first — the store, and the eight tools an agent drives it with — is already in `src/main/board/` and `view-mcp.ts`. Nothing here changes the format on disk.

## The tree navigates; the board acts

They are different documents. The tree is a `WebContentsView` of its own in the side column; the board is a panel inside the pane. So everything between them crosses main, exactly as a git row's click already reaches the diff. That is not overhead to be engineered away — it is what keeps each surface able to be drawn, and tested, without the other.

Each has one job:

- **The tree** is the only place all four levels are visible at once. It is how you find something.
- **The board** is where work moves. It shows the work that moves — and nothing else.

## The tree

`SideView` gains `'tasks'`, beside `'files'` and `'git'`. A third rail button, `⌘⌥T`, a `tasks.html` page with its own bundle, and `views.tasks` — the same shape the git panel added, for the same reason: three views that are rarely read at once do not each deserve permanent horizontal space.

Rows nest campaign → mission → task/bug, collapsible, each carrying a status chip and — for a campaign or a mission — the progress computed on read. Beneath them, a second root: `tests`, with its suites and the tests inside them. A test row shows what it validates and how many of those verdicts pass, which is the reverse of the workitem's chip and the only place that direction is visible. **Clicking a row scrolls the board to that lane and highlights it**, bringing the Board tab forward if the pane was showing something else — a reveal that scrolled a panel nobody could see would look like nothing happening. A campaign row reveals its heading, a mission row its lane, and a task or bug row its own card. The tree does not open files and does not change anything.

A project with no `.dsh/tasks/` is worded, not repaired, and says how a board gets started. The same three-states rule the git panel follows.

## The board

`PaneTab` gains `'board'`, a third panel in `pane.html` beside Editor and Web.

**Columns are the six statuses, always, whether or not anything is in them.** An empty column is information: it names a place work can go. The set never changes shape under the reader, and when the panel is too narrow the board scrolls sideways rather than dropping a column.

**Lanes are missions**, grouped under a campaign heading — including a mission with no work in it yet, which is a lane waiting to be filled rather than a mission that has gone missing. Bugs filed against a campaign rather than a mission get one lane of their own beneath it, so a bug is never homeless and never silently absent.

**Cards are task-level workitems and bugs.** A mission is a lane label carrying its own status chip; a campaign is a heading. Containers are structure here, and their statuses are read rather than dragged — which follows from the store's rule that a status is a claim with an author. A campaign and a task are not comparable units of work, and a board that put them in the same column would stop reading as a board.

**Tests are not cards.** They have no status, so there is no column they belong in, and a test is not work in flight — it is what the work is measured with. Instead a card carries a **validation chip**: `3/4 passing`, computed from that workitem's own `validated_by` verdicts. A chip with any failure in it reads as a failure, because one unproven check is the thing worth seeing from across the board. Clicking the chip opens the workitem's file, where the links and their verdicts are.

The tests themselves are browsed in the tree, under their own `tests` root.

### What a card shows

Its name, its type when it is a bug, how many of its acceptance criteria are ticked, and its validation chip when anything validates it. Nothing else. A card is scanned, not read; what it is *for* lives in the file, one click away.

## Acting

| Gesture | What runs |
| --- | --- |
| Drag a card to another column | `setStatus` |
| `+` on a mission's lane | `createEntity` at level `task`, under that mission |
| `+` on a campaign's bug lane | `createEntity` at level `bug`, under that campaign |
| Right-click a card → Delete | `trashEntity`, behind a confirmation naming it |
| Click a card | opens its `workitem.yaml` (`bug.yaml` for a bug) in the editor column |

Every one is a store call that already exists and is tested. The board adds gestures, not rules.

**Drag writes on drop, not on hover.** A card that changed status while being dragged over a column would write a status nobody chose, and every hover across a board would be a commit in someone's repository.

**Clicking a card opens the file.** There is no detail view. The editor already renders and edits prose well, the YAML is the truth rather than a projection of it, and an agent's edit to that file appears in a tab already open. A read-only detail panel would be a third surface showing what a file shows, kept in step by hand.

### Creating something opens a modal, and only its own controls close it

A `+` opens a small modal over the panel rather than an inline field. A card has a name, and a task should have its first acceptance criterion written while the thought that produced it is still there — two fields is past what an inline row carries well, and a modal is where a form belongs.

**It closes on Cancel and on its close control, and on nothing else.** Not on a click outside it, not on the backdrop. Losing a half-typed task to a stray click is small and infuriating, and it is exactly the kind of thing that stops someone trusting a board with anything they have not already written down elsewhere.

Escape is treated the same as the backdrop and does not close it either. That is a deliberate departure from what a dialog usually does, so both Cancel and Close are ordinary focusable controls reachable by Tab — a keyboard user is never trapped, they simply leave the way everyone else does. A modal that could be dismissed by the key next to the one you were typing in is not meaningfully safer than one dismissed by a click.

**What each `+` offers:**

| Opened from | Creates | Fields |
| --- | --- | --- |
| A mission's lane | a task | Name, and a first acceptance criterion |
| A campaign's bug lane | a bug | Name, and what happened |

The criterion field is not required — validation reports a task without one rather than refusing it, and the modal follows the store rather than inventing a stricter rule. But it is offered, and it is second, because a task whose definition of done is written at the moment it is created is the difference between a board that can gate work and a list of titles.

### Deliberately not editable here

Prose, acceptance criteria, renames, and creating campaigns or missions. Editing prose is what the editor is for. Creating structure is a planning act — the agent does it, or you do it in the file. The `+` makes a task because a task is the thing you jot mid-thought — and a bug on the lane that holds bugs, since a lane whose `+` produced something it could not display would be a control that lies about where its result went.

## One read, one change event

Main answers `tasks:read` with `readBoard(currentProject.path)` — the same pure rebuild the tools use, per workspace, never cached. Both surfaces call it; both listen for `tasks:changed`.

The board is re-read after a write it carried out, when the project changes, and when anything under `.dsh/tasks/` changes — debounced, superseded rather than queued, **waiting for git to go quiet first**, through the same debounce the git panel already uses. An agent writing a plan through its tools moves dozens of files in a second; without that wait, each one is a redraw.

Unlike the git panel's own notice, this one is never gated on whether a view is open: both pages are told on every change, whether or not their column is showing, so neither needs a catch-up read for opening late or for the window regaining focus — it was already being kept in step while nobody was looking.

Because both surfaces read the same channel and hear the same event, they cannot disagree about what is on the board. There is no shared state between them to keep in step — only the same files, read twice.

## Failing honestly

The store's findings — a file that will not parse, a status the board does not know, a task with no criterion — are already computed on read. Neither view shows them against the entity they name: the tree draws the same count the board does, in a line of its own above the rows, and a file that would not parse at all drops its entity from the tree entirely — there is no row left to mark it against. The one exception is narrower than a finding: a status outside what the board knows still gets its own chip on the row that carries it, because that entity parsed fine and made it into the tree; the file simply says something the board has no column for. The board carries the same count above its columns, telling the reader to open the tree for which. Neither hides an entity it could not read, and neither repairs one.

A write that fails reports the reason the store gave, on the surface that asked for it, in one line. A dragged card whose write failed **returns to the column it came from**: leaving it where it was dropped would show a status that is not in the file. That refusal takes over the board's own findings line, and no re-read clears it: `refresh()` and `draw()` never touch it, so it survives every redraw a `tasks:changed` notice triggers — including one raised by somebody else's write, on a board this view never touched — until this same view attempts another drag or delete and that one succeeds. A cancelled confirmation is not a refusal: the store answers it with no reason, the way Discard in the git panel does, and the line falls back to the findings count rather than going blank. A modal whose create failed **stays open with what was typed still in it**, and says why — closing it would throw away the work along with the error.

## Testing

The pure parts are the ones with the bugs in them, and they test without Electron:

- **Grouping** — turning a `Board` into campaigns, lanes and columns: a mission with no work, a campaign whose only children are bugs, a bug under a campaign versus one under a mission, and an entity whose status is not one of the six.
- **The tree's rows** — nesting, collapse, and what a row shows.
- **The board's drop** — which entity, which status, and that a refused write puts the card back.
- **Main's channels**, each gated against the open project, as every board channel already is.
- Each is broken deliberately to confirm its test fails, as this project asks of a test that guards something important.

The two cross-surface messages — the tree's reveal reaching the board, the card's click reaching the editor — are asserted where each page sends them, against a stubbed bridge: what the message is called and what it carries. Main's own forwarding of the two, where both ends would be visible at once, is not yet covered by a test of its own.

## Deliberately not in this

Filtering and search, assignees, due dates, reordering within a column, dragging a lane, a mobile or narrow layout beyond horizontal scroll, and any second board. None is assumed by anything above.
