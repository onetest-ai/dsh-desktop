# The task board

A board that lives in the repository. `.dsh/tasks/` holds one YAML file per entity; the panel and the agent both read and write those files, and git carries the history. No database, no server, no index to fall out of step with disk.

Adapted from `@octoshell/board`, which had already solved this and has the tests to show for it. What is taken, what is left, and what changed is recorded under *Vendoring* below.

## Why the files are the board

An agent that plans in a chat window loses the plan when the window closes. An agent that plans in a file leaves something reviewable in a pull request, survivable across machines, and readable by the next agent — or the next person — six months later.

Three properties follow from that and are worth stating as requirements rather than consequences:

- **Diffable.** A status change is a one-line diff with an author and a timestamp. The board's history is the repository's history, for free.
- **Mergeable.** Two agents on two branches can both add work, and git merges it, because they wrote different files.
- **Survivable.** Nothing to migrate, nothing to keep alive, nothing that can be lost by a cache going stale.

## Where it lives

`.dsh/tasks/`, beside the `.dsh/mcp.json` a project may already carry. The directory is the project's, committed like any other source.

```
.dsh/tasks/campaigns/<slug>/workitem.yaml                     subtype: campaign
                           /bugs/<slug>/bug.yaml
                           /missions/<slug>/workitem.yaml     subtype: mission
                                           /tasks/<slug>/workitem.yaml   subtype: task
                                           /bugs/<slug>/bug.yaml
.dsh/tasks/tests/<suite>/…/<slug>/test.yaml
```

A bug sits under exactly one parent — a campaign or a mission — whichever owns it. Tests live in their own container; everything else has one place it can be.

A project with no `.dsh/tasks/` has no board. That is a state the panel words, not one it repairs: creating a directory in someone's repository because they opened a view is not a thing to do unasked.

## Three types, and children are folder-derived

**Workitem** — the work itself, at one of three levels named by its `subtype`: a **campaign** is an outcome, a **mission** an independently shippable slice of it, a **task** one small verifiable unit. **Bug** — a defect, filed against whichever workitem owns it. **Test** — something that proves a workitem is done.

Three types rather than five kinds because a campaign, a mission and a task differ in altitude, not in nature: they carry the same fields, move through the same statuses, and every tool that acts on one acts on all three. A bug and a test are genuinely different things — a bug carries a reproduction, a test carries what it proves — and they earn their own files.

**A parent never lists its children.** A campaign's file says nothing about its missions; the missions are the subdirectories. This is the load-bearing decision of the whole design, and it buys three things at once:

- The entire class of bug where an index disagrees with disk cannot occur, because there is no index.
- Two agents adding tasks concurrently touch different files and never conflict.
- Reading the board is a pure rebuild from disk, never a projection that can drift.

**Status lives in the child's own file**, for the same reason. A mission does not track which of its tasks are done; it is computed by reading them.

### The path and the subtype say the same thing, and the path wins

A task lives under `missions/<m>/tasks/<t>/` *and* its file says `subtype: task`. That is deliberate redundancy, not an accident: the directory names are how the reader finds children without opening every file, and the key is what the entity claims to be. The reader trusts the path — it has to, to walk at all — and **a disagreement between them is a finding, never a repair.**

### Tests are a container, and the link carries the verdict

Tests live under `tests/`, in nested suites of any depth. **A suite is a directory, not a fourth type**: it has a slug and nothing else, because grouping is all it does, and a type that exists only to hold other things is a type whose file nobody would ever fill in.

**A test is a static asset.** It says what to do and what should happen, and that is all. It does not move through statuses, because a test is not work in flight — it is the instrument the work is measured with. The same test can be run a hundred times against a dozen workitems, and none of those runs is a property of the test.

**A workitem declares what proves it**, in a `validated_by` list — beside the acceptance criteria, because it is the same kind of statement. A criterion says what must be true; a `validated_by` entry says what demonstrates it, and what happened when it was last demonstrated:

```yaml
validated_by:
  - test: tests/auth/login-happy-path
    result: pass
    comment: ''
  - test: tests/auth/login-locked-account
    result: fail
    comment: 'returns 500 rather than 423'
    bug: campaigns/q3/bugs/locked-account-500
```

**`result` is one of `pass`, `fail`, `not_run`** — a fixed set, for the same reason statuses are fixed. `bug` names the defect a failure produced, when one was filed; a failing test with no bug is a failure nobody has written down yet, and the panel says so rather than assuming it is fine.

The verdict lives on the **link**, not on the test, because a verdict is about a pairing. One test can pass for the mission it was written for and fail for the one that reused it, and both are true at once. A result stored on the test could only ever record the last of them.

### The link lives in the workitem, and why that is not the conflict we closed

Creating a test touches only the test's own file. Only *linking* touches a workitem, and linking is a deliberate act on that workitem's contract — exactly as adding a criterion is. The rule folder-derived children protect is *creating a child forcing an edit to the parent*, and nothing here does that.

The cost is real and is stated rather than discovered: **a test that is deleted or moved leaves a dangling path behind in whatever named it.** That is a finding against the workitem holding it, never a silent drop — a `validated_by` entry that quietly vanished would turn "this is proven" into "this was proven once" with nothing to say so.

### The test records its own runs, so flakiness is visible

A verdict on a link answers "does this pass here, now". It cannot answer "does this test give the same answer twice", and that question is the difference between a real failure and a flaky one.

So the test file keeps its own `runs` list — when it ran, against what, and what came out:

```yaml
runs:
  - at: 2026-09-05T09:12:00Z
    workitem: campaigns/q3/missions/m1
    result: pass
  - at: 2026-09-05T09:47:00Z
    workitem: campaigns/q3/missions/m1
    result: fail
```

The same run therefore lands in two places — the verdict on the workitem's link, the record on the test — and **they can disagree**, because a link is updated deliberately and a run is appended automatically. That is not a bug to design away; it is the shape of the thing. Reconciling them is how a stale verdict gets noticed.

**The list is capped at the most recent 50 runs**, oldest dropped. Flakiness is visible in a window, git holds everything older, and an uncapped list makes every run a write to a file that only grows. The cap is a number in one place, so raising it is a decision rather than a refactor.

Trend analysis, quarantining a flaky test, and reconciling a link's verdict against the runs behind it are all deliberately out of scope — the data is recorded so those become possible, not because they are being built now.

### Identity

An entity's id is derived from its folder path — `folder:campaigns/x/missions/y`. There is no id file and no generated identifier, because the folder already is one and a second source of identity is a second thing that can disagree.

The cost is that **moving or renaming a folder changes the entity's id.** That is acceptable here: nothing stores an id, every reference is a path, and the board is rebuilt from disk on every change. It is stated so that a later feature which wants to store an id knows it is buying a problem.

## The schema

On-disk keys are `snake_case`. Every type carries `name`, `description` and `notes`; the rest is per type, and for a workitem, per subtype.

| Key | workitem | bug | test |
| --- | --- | --- | --- |
| `name`, `description`, `notes` | ✓ | ✓ | ✓ |
| `status` — one of the six | ✓ | ✓ | |
| `subtype` — `campaign`, `mission` or `task` | ✓ | | |
| `acceptance_criteria` | ✓ | | |
| `validated_by` — test links with verdicts | ✓ | | |
| `documents` | campaign, mission | | |
| `target` | campaign | | |
| `role` | task | | |
| `severity`, `steps_to_reproduce`, `expected`, `actual`, `rca`, `environment` | | ✓ | |
| `steps`, `expected` | | | ✓ |
| `runs` — execution history, capped at 50 | | | ✓ |

A key a subtype does not own is not written for it, but a key already on disk is never destroyed — see *Unknown keys round-trip*. So a `target` on a task is malformed rather than lost, and shows up as a finding.

**A test carries what it proves**: `steps` and `expected`, the two things that make a test repeatable by someone who did not write it. It does not carry acceptance criteria — a test *is* a criterion, made executable, and giving it criteria of its own would ask what proves the proof.

**A test has no status**, which is the one asymmetry in the model and is deliberate. Statuses describe work moving toward done; a test is not moving. What a test has is *results*, and a result belongs to a pairing rather than to the test — so it lives on the link. Retiring a test is therefore unlinking it, not marking it: validation *is* the link, and a test nothing points at proves nothing, which is exactly what retired means.

**Status** is one of `draft`, `executing`, `awaitingApproval`, `done`, `failed`, `cancelled`. These are the board's columns. The set is fixed — a status the schema does not know is a validation finding, not a new column, because a board whose columns are whatever anyone typed is not a board.

**An acceptance criterion** is `{ text, done }`. A task with no criterion is a planning defect: a task with no checkable definition of done cannot be gated, and gating is the point. Validation says so; it does not refuse the write.

**Statuses are the same six for workitems and bugs.** Tests have none; see the schema table above. A link's `result` — `pass`, `fail`, `not_run` — is a separate fixed set and never mixes with them: a status says how far work has got, a result says whether a check held, and a column vocabulary that ran both together would be answering two questions in one row.

### Status is set, never inferred

**Nothing changes an entity's status but a person or an agent saying so.** A mission does not become `done` because its last task did; a campaign does not become `executing` because a mission started. There is no rollup, no cascade, and no completion that fires on its own.

Upstream derives a parent's status from its children unless it is explicitly overridden — `managed-block.ts` calls it "the mission rollup". The cost of that is not the arithmetic, it is the ambiguity: reading `executing` on a campaign, you cannot tell whether someone decided it or whether a child moved and the number followed. A status that means two different things is worse than a stale one, because a stale status is at least a claim somebody made.

So the rule is: **a status is a claim, and claims have authors.** Setting one is a write, from the panel or from `board_status`, and it lands in a diff with a name against it.

**Progress is computed and shown, never written.** "3 of 7 children done" (missions and bugs together, under a campaign), "5 of 6 criteria ticked" — those are read off disk every rebuild and rendered. They inform the person deciding; they do not decide. That distinction is the whole of this rule: derive what you display, never what you store.

### Unknown keys round-trip

Every write rewrites the whole file from parsed fields. Without deliberate care that destroys any key the schema does not model — which is how octoshell lost a campaign's recorded decisions, and why they now carry unknown top-level keys through an `extra` map and re-emit them.

That behaviour is taken as-is. It is not a nicety: it is what makes it safe for an agent to add a key this schema has never heard of, and for the panel to edit the same file afterwards.

## Reading

`BoardModel(root)` with a single `rebuild()` that re-reads everything. Pure, synchronous, no incremental invalidation.

Incremental update is the obvious optimisation and it is deliberately not taken. A board is tens to low hundreds of small YAML files; a full rebuild is milliseconds, and it cannot drift. If a board ever grows large enough for this to hurt, that is a measurement, not a prediction.

Reading never writes. A malformed file yields a validation finding and an entity that is absent from the board, never a repair.

## Writing

Create, edit, set status, add and tick criteria, attach a document, delete. Every write is a whole-file rewrite through the schema, through this app's own `atomic-write.ts`, and every write is followed by the watcher telling the panel to re-read — main does not maintain a second copy of the truth.

**Delete moves to `.dsh/tasks/.trash/`** rather than removing the folder. A board entity carries the plan and the acceptance criteria for real work, and an accidental delete that is only recoverable through git's reflog is one that will be recovered by nobody.

## Concurrency, and the watcher

The panel, the agent's tools, an agent in the terminal, and `git checkout` all write these files. Only the first is observable directly, so the rest are watched for.

The board is re-read when the panel opens, after a write it carried out, when the window regains focus, when the project changes, and when anything under `.dsh/tasks/` changes — debounced, superseded rather than queued, through the same mechanism the git panel already uses. **The watcher waits for git to go quiet first**, so a rebase or a branch switch produces one re-read rather than a storm of half-written states.

There is no lock. Two writers to the *same* entity is last-write-wins, and that is the honest behaviour for files: git has the previous version, and folder-derived children mean the case that actually happens — two agents adding different work — never collides at all.

## The agent's tools

The tools go in `src/main/view-mcp.ts`, beside the ones that open a file and drive the browser. This app already runs its own MCP server; the board needs no plugin package, no published skill pack, and no second mechanism.

| Tool | |
| --- | --- |
| `board_read` | The whole board, as structure |
| `board_create` | A workitem of a given subtype, a bug, or a test |
| `board_update` | Name, description, notes, and the per-type fields |
| `board_status` | Move an entity to a status |
| `board_criterion` | Add a criterion, or tick one |
| `board_link` | Link a test to a workitem, record a verdict, or unlink it |
| `board_run` | Append a run to a test's history |
| `board_delete` | To the trash |

**Every path argument is checked against the project roots**, exactly as `view-mcp.ts` already does for every file it opens. An agent naming a directory is not evidence the project holds it.

Tool descriptions carry the rules the schema enforces — a task needs a criterion, the status set is fixed, children are folder-derived, a workitem declares what validates it — because the tool description is where an agent learns how to use a board, and a rule discovered through a rejection is a rule learned expensively.

## Failing honestly

A file that will not parse, a status that is not in the set, a task with no criteria, an entity whose folder does not match its type, a `subtype` that disagrees with the path it sits on, a `validated_by` naming a test that is not there, a link whose `result` is not one of the three, a failing link with no bug against it: each is a **finding** naming the file and what is wrong, surfaced rather than repaired. The board reports the entities it could read and says how many it could not.

The rule is the one the rest of this app follows: say what was observed, never a stack trace, and never invent structure where the input did not carry it.

## Vendoring

Taken from `@octoshell/board` into `src/main/board/`, with a README recording the upstream commit and the refresh procedure — the policy `vendor/dsh-theme/README.md` already sets.

**Taken nearly verbatim:** `entity-schema.ts` — the YAML round-trip, including the `extra` passthrough — and `slug.ts`, with their tests. This is the subtle part, the part with the scars on it, and the part that is genuinely self-contained: its only import is `js-yaml`.

**Written fresh:** the reader, the writer and the validator. Upstream's are 744 and 915 lines, and most of that is what this board does not have — reading Markdown as well as YAML, the `isYaml` branch through every path, legacy id markers, workflow parsing, and the migrations off the old format. Taking them would mean vendoring the legacy handling in order to delete it. A YAML-only reader over three types is a small fraction of that, and the behaviour worth keeping is in the schema, which we do take.

**Left behind, with reasons:**

- **Workflows** (`workflow-meta.ts`, `extract-meta.ts`) — execution graphs describing *how* a mission runs. Not a board entity, and the heaviest thing in the package: 644 lines and the only use of the `acorn` dependency, which therefore is not taken either.
- **Tokenomics** — cost attribution read from agent transcripts that live outside the repository and are pruned. A reporting feature with its own collection timing, separable entirely.
- **`managed-block.ts` and the migrations** — the older Markdown format and the path off it. This board is YAML from its first commit and has nothing to migrate.
- **`missingIdFiles`** — legacy id markers that only existed for Markdown entities.
- **The mission rollup** — a parent's status derived from its children. See *Status is set, never inferred*.

**Changed:** the root moves from `.octobots/` to `.dsh/tasks/`; imports adapt to this repo's CommonJS main-process build rather than the upstream ESM package; and the source is restyled to this repo's conventions, since no formatter is configured here and upstream's differs.

### The js-yaml version hazard

Upstream is on `js-yaml@^5.2.2`; this app already depends on `^4.3.1`, and **the two differ on the case the board actually hits**: v5 throws a `YAMLException` on an empty file where v4 returns `{}`. Upstream's own acceptance criteria record this, having been bitten by it.

**The decision is to stay on v4 and port**, for a reason beyond inertia: v4's behaviour is the one we want. A config reader that throws on an empty file is worse than one that reads it as empty, and this app's two existing call sites — `harness-theme.ts`, reading a `settings.yaml` it does not own, and `bundle-patch.ts` — would both inherit the regression. `load` and `dump` are otherwise compatible, so the port is small.

Empty, blank and whitespace-only files are therefore a test case rather than an assumption. Adding a second copy of js-yaml to avoid porting would be the worst option of the three: two YAML parsers in one process, disagreeing on exactly the inputs that break.

## Testing

The hard parts are pure functions over bytes, so they test without Electron alongside the rest of the main-process suite.

- **The schema** carries the bulk: round-trips per kind, unknown-key passthrough, the empty-file case above, criteria shapes, and a malformed file yielding a finding rather than a throw.
- **`BoardModel`** against temporary trees: a full four-level board, a mission with no tasks, a bug under a campaign and a bug under a mission, a folder with no YAML in it, and a board that is not there at all.
- **The write paths**, each asserting the file on disk afterwards — including that an unmodelled key survives an unrelated edit, which is the regression that motivated `extra` upstream.
- **Each tool**, that it refuses a path outside the project roots.
- **That no write to a child ever changes its parent's status** — the regression this design is defined against, and the one a later convenience feature is most likely to reintroduce.
- Each parser is broken deliberately to confirm its test fails, as this project asks of a test that guards something important.

## Deliberately not in this

The tree view and the board view — both are the next plan, and this one ends with a store and an agent that can drive it. Workflows, tokenomics, cross-repository boards, assignees, due dates, and any notion of a sprint. None is assumed by anything above.
