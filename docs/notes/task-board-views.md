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

Rows nest campaign → mission → task/bug, collapsible, each carrying a status chip and — for a campaign or a mission — the progress computed on read. Beneath them, a second root: `tests`, with its suites and the tests inside them. A test row shows what it validates and how many of those verdicts pass, which is the reverse of the workitem's chip and the only place that direction is visible. **Clicking a row scrolls the board to whatever that row is on it and highlights that**, bringing the Board tab forward if the pane was showing something else — a reveal that scrolled a panel nobody could see would look like nothing happening. A campaign row reveals its heading, a mission row its lane, and a task or bug row its own card. A test row reveals nothing, because the board deliberately draws no card for a test — it opens the test's own detail instead, which is the one thing a test row can go to and the same thing a card's click does for a workitem. The tree sends the same message for a test that it sends for every other row: it names a folder, and the board decides. That is the side that knows which paths are tests, because it holds the suite tree the read answered with, and it is what keeps this page free of a second cross-surface message that would mean the same thing. A test row is the tree's only exception: nothing here changes anything.

A fold is remembered by folder path and forgotten when the project changes. `campaigns/q3` is a path two projects can both have, and reopening the next one already folded would be this state describing a board it was never about.

A project with no `.dsh/tasks/` is worded, not repaired, and says how a board gets started — and no project open at all is worded differently again, since advice to create a campaign would be naming a place that does not exist. The same three-states rule the git panel follows.

## The board

`PaneTab` gains `'board'`, a third panel in `pane.html` beside Editor and Web.

**Columns are the five statuses, always** — `idea`, `backlog`, `executing`, `validation`, `done` — whether or not anything is in them. An empty column is information: it names a place work can go to. The set never changes shape under the reader, and when the panel is too narrow the board scrolls sideways rather than dropping a column.

**Lanes are missions**, grouped under a campaign, and **both fold**. A mission's header is its own toggle; a folded lane still says what it holds, so folding is a way of putting something down rather than losing it. A campaign folds the same way, because a real project has more campaigns than fit on a screen and most of them are not today's.

**A campaign can also be hidden**, which is different from folded: hidden is off the board entirely. A `N hidden` control at the top is the way back, and it lists everything hidden however it got there. **A `done` campaign hides itself** — finished work does not need a decision — but it is not special, because it appears in that same list. Nothing disappears without somewhere to look for it.

**Campaigns sort by status, then by name**: executing, then validation, then backlog, then idea. What needs you above what is waiting. Alphabetical within each, because a board that reorders under you as statuses change is one you cannot build a habit around.

**The nesting is drawn, not implied.** A campaign's lanes are indented beneath it with a rule running down the group, so a folded mission and a folded campaign — which are otherwise the same shape — cannot be mistaken for siblings, and an open campaign has a visible extent.

**Cards are task-level workitems and bugs.** A mission is a lane label carrying its own status chip; a campaign is a heading. Containers are structure here, and their statuses are read rather than dragged — which follows from the store's rule that a status is a claim with an author. A campaign and a task are not comparable units of work, and a board that put them in the same column would stop reading as a board.

**Tests are not cards.** They have no status, so there is no column they belong in, and a test is not work in flight — it is what the work is measured with. Instead a card carries a **validation chip**: `3/4 passing`, computed from that workitem's own `validated_by` verdicts. A chip with any failure in it reads as a failure, because one unproven check is the thing worth seeing from across the board. Clicking the chip opens the workitem's detail, where the links and their verdicts are.

The tests themselves are browsed in the tree and on the board's own Tests destination — see *Seeing tests*.

### What a card shows

Its name on its own line, wrapping to two and then ellipsing — a card that cannot show what it is called is not a card, which is the first thing the original columns got wrong by being too narrow to hold one. Beneath it, quieter: its type when it is a bug, how many acceptance criteria are ticked, and its validation chip when anything validates it. Nothing else. A card is scanned, not read; what it is *for* lives in its detail, one click away.

**A status reads as a label wherever the board draws it, not as a field name.** `validation` renders as Validation — in a column heading, and on a mission's lane beside it. The stored value is untouched — the display is the view's business and the file's word is the store's — and one status shown twice on one screen should not read two ways.

## The detail view

**A click on a card opens the entity's detail in the board panel itself**, replacing the columns, with a back control at the top left. The board is where you were; the detail is where you went; back is how you return. Nothing about that needs a second window.

Not a modal. A modal is for a decision that must be made before anything else can happen, and reading a mission is not one — you read it, you follow a link to a test, you come back. A modal that could be stacked would be a browser with no address bar, and one that could not would make every link a dead end.

Not the editor column either, which is what it was and what was wrong with it. The editor showed `workitem.yaml`, so the answer to "what is this task" was a serialised map. The file format change fixes the file; this fixes where a click lands. Both are needed: the file is now worth opening, and opening it is still a detour when all you wanted was to see the thing you clicked.

**What it shows**, in octoshell's order, which is the order a reader wants: the name and its status as a heading, the parent it belongs to under that, then the description, then the level's own sections, then its children. Prose sections render as markdown — a test's Steps table is a table, not a wall of pipes.

**Children are rows, not cards**: a mission lists its tasks, its bugs and the tests that validate it, each a line with a name, a status and — for a test — the verdict it last returned here. A row opens that entity's detail, so the surface navigates into itself, and back walks out the way it came.

**Two things are editable here**, because both are already writes the board owns: the status, through a select, and an acceptance criterion, through its checkbox. Everything else is read, with an **Open file** control that hands the entity's `.md` to the editor column for anyone who wants to write prose. That is the same division the board already draws — the panel moves work, the editor writes it — and now the file it opens reads like a document.

**Detail is per-session and not remembered.** Reopening the panel shows the board. A view that reopened on the task you were reading last Tuesday is a view that has decided something for you.

### Seeing tests

A test has no status, so it has no column, and until now that meant it had no way onto the board at all — you could reach one only by knowing it existed and finding it in the tree. That is the second half of the same complaint: the board's whole job is to show what is there.

**The board gains a Tests destination**, reached from its own header, rendering the suite tree with its cases: suites as headings, tests as rows, each with the count of what it validates and how much of that passes. A row opens the test's detail, which is the same surface everything else opens into.

The control is on the header whether or not this board has a test in it, and the destination words its own emptiness: one that came and went with the suite tree would make Tests something you have to already know about, which is the thing it exists to fix. **Back walks out one level, not all the way**: a test opened from here returns to the list it was picked from, and only the list's own back reaches the columns — a detail that dropped the reader on the board would undo the navigation rather than reverse it. The header belongs to the columns alone; each destination carries its own back, and a second way out beside it would go somewhere the reader did not come from.

**A workitem's detail lists what validates it** — one row per `validated_by` link, with the verdict, the comment, and the bug when a failure filed one. That is where a failing check is explained, and it is the reason the link lives in the workitem rather than in the test.

## Acting

| Gesture | What runs |
| --- | --- |
| Drag a card to another column | `setStatus` |
| `+` on a mission's lane | `createEntity` at level `task`, under that mission |
| `+` on a campaign's bug lane | `createEntity` at level `bug`, under that campaign |
| Right-click a card → Delete | `trashEntity`, behind a confirmation naming the entity as the card does |
| Click a card | opens its detail, in place of the columns |
| Change the status select in a detail | `setStatus` |
| Tick a criterion in a detail | `tickCriterion` |
| **Open file** in a detail | opens its `workitem.md` (`bug.md`, `test.md`) in the editor column |

Every one is a store call that already exists and is tested. The board adds gestures, not rules.

**Drag writes on drop, not on hover.** A card that changed status while being dragged over a column would write a status nobody chose, and every hover across a board would be a commit in someone's repository.

**A detail is drawn from the same read as the board**, never from a cached copy and never from a write's answer. The store re-reads the whole board on every change and the panel redraws from that; a detail open on an entity an agent just edited redraws with the edit, and a detail open on one that was deleted falls back to the board with a line saying so. That is what keeps a third surface honest — it is the same data, drawn twice, not a copy kept in step by hand.

### Creating something opens a modal, and only its own controls close it

A `+` opens a small modal over the panel rather than an inline field. A card has a name, and a task should have its first acceptance criterion written while the thought that produced it is still there — two fields is past what an inline row carries well, and a modal is where a form belongs.

**It closes on Cancel and on its close control, and on nothing else.** Not on a click outside it, not on the backdrop. Losing a half-typed task to a stray click is small and infuriating, and it is exactly the kind of thing that stops someone trusting a board with anything they have not already written down elsewhere.

The backdrop nonetheless takes pointer events, which is what makes the modal modal: it is the hit-test target for every click over the panel, so the lane pluses and cards visible through it cannot be pressed while a name is half typed. A backdrop that took none would be click-through — the `+` below would reopen the modal with both fields cleared, and a card could be opened or dragged to a new status mid-create. Catching the click is all it does with it.

Escape is treated the same as the backdrop and does not close it either. That is a deliberate departure from what a dialog usually does, so both Cancel and Close are ordinary focusable controls reachable by Tab — a keyboard user is never trapped, they simply leave the way everyone else does. A modal that could be dismissed by the key next to the one you were typing in is not meaningfully safer than one dismissed by a click.

**What each `+` offers:**

| Opened from | Creates | Fields |
| --- | --- | --- |
| A mission's lane | a task | Name, and a first acceptance criterion |
| A campaign's bug lane | a bug | Name, and what happened |

The criterion field is not required — validation reports a task without one rather than refusing it, and the modal follows the store rather than inventing a stricter rule. But it is offered, and it is second, because a task whose definition of done is written at the moment it is created is the difference between a board that can gate work and a list of titles.

### Deliberately not editable here

Prose, renames, and creating campaigns or missions. Editing prose is what the editor is for. Creating structure is a planning act — the agent does it, or you do it in the file. The `+` makes a task because a task is the thing you jot mid-thought — and a bug on the lane that holds bugs, since a lane whose `+` produced something it could not display would be a control that lies about where its result went.

## What the view remembers

Folding, and which detail is open, are per view and per session: it is a posture, not a decision, and one that survived a restart would leave someone opening a board they had folded away a week ago and forgotten.

**Hiding is a decision and it persists**, stored per project. Hiding something and finding it back tomorrow is the whole point; a hidden campaign that reappeared on restart would just be a slower fold.

Both are keyed by folder path, and both are cleared when the project changes — the same path names different work in a different repository, and a lane highlighted in one project because another had the same slug is a small madness.

## One read, one change event

Main answers `tasks:read` with `readBoard(currentProject.path)` — the same pure rebuild the tools use, per workspace, never cached. Both surfaces call it; both listen for `tasks:changed`.

The board is re-read after a write it carried out, when the project changes, and when anything under `.dsh/tasks/` changes — debounced, superseded rather than queued, **waiting for git to go quiet first**, through the same debounce the git panel already uses. An agent writing a plan through its tools moves dozens of files in a second; without that wait, each one is a redraw.

Unlike the git panel's own notice, this one is never gated on whether a view is open: both pages are told on every change, whether or not their column is showing, so neither needs a catch-up read for opening late or for the window regaining focus — it was already being kept in step while nobody was looking.

Because both surfaces read the same channel and hear the same event, they cannot disagree about what is on the board. There is no shared state between them to keep in step — only the same files, read twice.

## Failing honestly

The store's findings — a file that will not parse, a status the board does not know, a task with no criterion — are already computed on read. Neither view shows them against the entity they name: the tree draws the same count the board does, in a line of its own above the rows, and a file that would not parse at all drops its entity from the tree entirely — there is no row left to mark it against. The one exception is narrower than a finding: a status outside what the board knows still gets its own chip on the row that carries it, because that entity parsed fine and made it into the tree; the file simply says something the board has no column for. The board carries the same count above its columns, telling the reader to open the tree for which. Neither hides an entity it could not read, and neither repairs one.

A write that fails reports the reason the store gave, on the surface that asked for it, in one line. A dragged card whose write failed **returns to the column it came from**: leaving it where it was dropped would show a status that is not in the file. That refusal takes over the board's own findings line, and no re-read of the same board clears it: `draw()` never touches it, so it survives every redraw a `tasks:changed` notice triggers — including one raised by somebody else's write, on a board this view never touched — until this same view makes another write of its own — a drag, a delete, a status, a tick — that succeeds. A read that comes back from a *different* project does clear it, along with the reveal's highlight: both are notes about one board's paths, and `campaigns/q3` in the project that just opened is not the card the refusal was about. A cancelled confirmation is not a refusal: the store answers it with no reason, the way Discard in the git panel does, and the line falls back to the findings count rather than going blank. A modal whose create failed **stays open with what was typed still in it**, and says why — closing it would throw away the work along with the error.

## Testing

The pure parts are the ones with the bugs in them, and they test without Electron:

- **Grouping** — turning a `Board` into campaigns, lanes and columns: a mission with no work, a campaign whose only children are bugs, a bug under a campaign versus one under a mission, and an entity whose status is not one of the five.
- **The tree's rows** — nesting, collapse, and what a row shows.
- **The board's drop** — which entity, which status, and that a refused write puts the card back.
- **Main's channels**, each gated against the open project, as every board channel already is.
- Each is broken deliberately to confirm its test fails, as this project asks of a test that guards something important.

The two cross-surface messages — the tree's reveal reaching the board, the card's click reaching the editor — are asserted where each page sends them, against a stubbed bridge: what the message is called and what it carries, and — for the reveal — which of the board's four kinds of row it marks, plus the fifth it does not: a test, whose folder path the board answers by opening its detail rather than by marking anything. Main's forwarding of both is covered where the channels are, against the real store.

## Deliberately not in this

Filtering and search, assignees, due dates, reordering within a column, dragging a lane, a mobile or narrow layout beyond horizontal scroll, and any second board. None is assumed by anything above.
