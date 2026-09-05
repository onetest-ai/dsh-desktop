# The task board's two views

The board from `docs/notes/task-board.md` becomes visible: a tree of the hierarchy in the side column, and a swimlane board in the content panel. Both read the same files, both listen for the same change, and neither holds a copy of the truth.

This is the second half of the board. The first — the store, and the six tools an agent drives it with — is already in `src/main/board/` and `view-mcp.ts`. Nothing here changes the format on disk.

## The tree navigates; the board acts

They are different documents. The tree is a `WebContentsView` of its own in the side column; the board is a panel inside the pane. So everything between them crosses main, exactly as a git row's click already reaches the diff. That is not overhead to be engineered away — it is what keeps each surface able to be drawn, and tested, without the other.

Each has one job:

- **The tree** is the only place all four levels are visible at once. It is how you find something.
- **The board** is where work moves. It shows the work that moves — and nothing else.

## The tree

`SideView` gains `'tasks'`, beside `'files'` and `'git'`. A third rail button, `⌘⌥T`, a `tasks.html` page with its own bundle, and `views.tasks` — the same shape the git panel added, for the same reason: three views that are rarely read at once do not each deserve permanent horizontal space.

Rows nest campaign → mission → task/bug, collapsible, each carrying a status chip and — for a campaign or a mission — the progress computed on read. **Clicking a row scrolls the board to that lane and highlights it**, bringing the Board tab forward if the pane was showing something else — a reveal that scrolled a panel nobody could see would look like nothing happening. A campaign row reveals its heading, a mission row its lane, and a task or bug row its own card. The tree does not open files and does not change anything.

A project with no `.dsh/tasks/` is worded, not repaired, and says how a board gets started. The same three-states rule the git panel follows.

## The board

`PaneTab` gains `'board'`, a third panel in `pane.html` beside Editor and Web.

**Columns are the six statuses, always, whether or not anything is in them.** An empty column is information: it names a place work can go. The set never changes shape under the reader, and when the panel is too narrow the board scrolls sideways rather than dropping a column.

**Lanes are missions**, grouped under a campaign heading — including a mission with no work in it yet, which is a lane waiting to be filled rather than a mission that has gone missing. Bugs filed against a campaign rather than a mission get one lane of their own beneath it, so a bug is never homeless and never silently absent.

**Cards are tasks and bugs.** A mission is a lane label carrying its own status chip; a campaign is a heading. Containers are structure here, and their statuses are read rather than dragged — which follows from the store's rule that a status is a claim with an author. A campaign and a task are not comparable units of work, and a board that put them in the same column would stop reading as a board.

### What a card shows

Its name, its kind when it is a bug, and how many of its acceptance criteria are ticked. Nothing else. A card is scanned, not read; what it is *for* lives in the file, one click away.

## Acting

| Gesture | What runs |
| --- | --- |
| Drag a card to another column | `setStatus` |
| `+` on a mission's lane | `createEntity`, kind `task`, under that mission |
| `+` on a campaign's bug lane | `createEntity`, kind `bug`, under that campaign |
| Right-click a card → Delete | `trashEntity`, behind a confirmation naming it |
| Click a card | opens its `task.yaml` in the editor column |

Every one is a store call that already exists and is tested. The board adds gestures, not rules.

**Drag writes on drop, not on hover.** A card that changed status while being dragged over a column would write a status nobody chose, and every hover across a board would be a commit in someone's repository.

**Clicking a card opens the file.** There is no detail view. The editor already renders and edits prose well, the YAML is the truth rather than a projection of it, and an agent's edit to that file appears in a tab already open. A read-only detail panel would be a third surface showing what a file shows, kept in step by hand.

### Deliberately not editable here

Prose, acceptance criteria, renames, and creating campaigns or missions. Editing prose is what the editor is for. Creating structure is a planning act — the agent does it, or you do it in the file. The `+` makes a task because a task is the thing you jot mid-thought — and a bug on the lane that holds bugs, since a lane whose `+` produced something it could not display would be a control that lies about where its result went.

## One read, one change event

Main answers `tasks:read` with `readBoard(currentProject.path)` — the same pure rebuild the tools use, per workspace, never cached. Both surfaces call it; both listen for `tasks:changed`.

The board is re-read when either view opens, after a write it carried out, when the window regains focus, when the project changes, and when anything under `.dsh/tasks/` changes — debounced, superseded rather than queued, **waiting for git to go quiet first**, through the same mechanism the git panel already uses. An agent writing a plan through its tools moves dozens of files in a second; without that wait, each one is a redraw.

Because both surfaces read the same channel and hear the same event, they cannot disagree about what is on the board. There is no shared state between them to keep in step — only the same files, read twice.

## Failing honestly

The store's findings — a file that will not parse, a status the board does not know, a task with no criterion — are already computed on read. The tree shows them against the entity they name. The board cannot — a finding's entity is by definition not on it — so the board carries a line above the columns saying how many files it could not read, which opens the tree. Neither hides an entity it could not read, and neither repairs one.

A write that fails reports the reason the store gave, on the surface that asked for it, in one line. A dragged card whose write failed **returns to the column it came from**: leaving it where it was dropped would show a status that is not in the file.

## Testing

The pure parts are the ones with the bugs in them, and they test without Electron:

- **Grouping** — turning a `Board` into campaigns, lanes and columns: a mission with no work, a campaign whose only children are bugs, a bug under a campaign versus one under a mission, and an entity whose status is not one of the six.
- **The tree's rows** — nesting, collapse, and what a row shows.
- **The board's drop** — which entity, which status, and that a refused write puts the card back.
- **Main's channels**, each gated against the open project, as every board channel already is.
- Each is broken deliberately to confirm its test fails, as this project asks of a test that guards something important.

The two cross-surface messages — the tree's reveal reaching the board, the card's click reaching the editor — are asserted in main, where both ends are visible.

## Deliberately not in this

Filtering and search, assignees, due dates, reordering within a column, dragging a lane, a mobile or narrow layout beyond horizontal scroll, and any second board. None is assumed by anything above.
