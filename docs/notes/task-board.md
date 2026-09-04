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
.dsh/tasks/campaigns/<slug>/campaign.yaml
                           /bugs/<slug>/bug.yaml
                           /missions/<slug>/mission.yaml
                                           /tasks/<slug>/task.yaml
                                           /bugs/<slug>/bug.yaml
```

A bug sits under exactly one parent — a campaign or a mission — whichever owns it. Everything else has one place it can be.

A project with no `.dsh/tasks/` has no board. That is a state the panel words, not one it repairs: creating a directory in someone's repository because they opened a view is not a thing to do unasked.

## Four kinds, and children are folder-derived

**Campaign** — an outcome. **Mission** — an independently shippable slice of it. **Task** — one small verifiable unit. **Bug** — a defect, filed against whichever parent owns it.

**A parent never lists its children.** A campaign's file says nothing about its missions; the missions are the subdirectories. This is the load-bearing decision of the whole design, and it buys three things at once:

- The entire class of bug where an index disagrees with disk cannot occur, because there is no index.
- Two agents adding tasks concurrently touch different files and never conflict.
- Reading the board is a pure rebuild from disk, never a projection that can drift.

**Status lives in the child's own file**, for the same reason. A mission does not track which of its tasks are done; it is computed by reading them.

### Identity

An entity's id is derived from its folder path — `folder:campaigns/x/missions/y`. There is no id file and no generated identifier, because the folder already is one and a second source of identity is a second thing that can disagree.

The cost is that **moving or renaming a folder changes the entity's id.** That is acceptable here: nothing stores an id, every reference is a path, and the board is rebuilt from disk on every change. It is stated so that a later feature which wants to store an id knows it is buying a problem.

## The schema

On-disk keys are `snake_case`. Every kind carries `name`, `status`, `description` and `notes`; the rest is per kind.

| Key | campaign | mission | task | bug |
| --- | --- | --- | --- | --- |
| `name`, `status`, `description`, `notes` | ✓ | ✓ | ✓ | ✓ |
| `acceptance_criteria` | ✓ | ✓ | ✓ | |
| `documents` | ✓ | ✓ | | |
| `target` | ✓ | | | |
| `role` | | | ✓ | |
| `severity`, `steps_to_reproduce`, `expected`, `actual`, `rca`, `environment` | | | | ✓ |

**Status** is one of `draft`, `executing`, `awaitingApproval`, `done`, `failed`, `cancelled`. These are the board's columns. The set is fixed — a status the schema does not know is a validation finding, not a new column, because a board whose columns are whatever anyone typed is not a board.

**An acceptance criterion** is `{ text, done }`. A task with no criterion is a planning defect: a task with no checkable definition of done cannot be gated, and gating is the point. Validation says so; it does not refuse the write.

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
| `board_create` | A campaign, mission, task or bug under a named parent |
| `board_update` | Name, description, notes, and the per-kind fields |
| `board_status` | Move an entity to a status |
| `board_criterion` | Add a criterion, or tick one |
| `board_delete` | To the trash |

**Every path argument is checked against the project roots**, exactly as `view-mcp.ts` already does for every file it opens. An agent naming a directory is not evidence the project holds it.

Tool descriptions carry the rules the schema enforces — a task needs a criterion, statuses are closed, children are folder-derived — because the tool description is where an agent learns how to use a board, and a rule discovered through a rejection is a rule learned expensively.

## Failing honestly

A file that will not parse, a status that is not in the set, a task with no criteria, an entity whose folder does not match its kind: each is a **finding** naming the file and what is wrong, surfaced rather than repaired. The board reports the entities it could read and says how many it could not.

The rule is the one the rest of this app follows: say what was observed, never a stack trace, and never invent structure where the input did not carry it.

## Vendoring

Taken from `@octoshell/board` into `src/main/board/`, with a README recording the upstream commit and the refresh procedure — the policy `vendor/dsh-theme/README.md` already sets.

**Taken nearly verbatim:** `entity-schema.ts` — the YAML round-trip, including the `extra` passthrough — and `slug.ts`, with their tests. This is the subtle part, the part with the scars on it, and the part that is genuinely self-contained: its only import is `js-yaml`.

**Written fresh:** the reader, the writer and the validator. Upstream's are 744 and 915 lines, and most of that is what this board does not have — reading Markdown as well as YAML, the `isYaml` branch through every path, legacy id markers, workflow parsing, and the migrations off the old format. Taking them would mean vendoring the legacy handling in order to delete it. A YAML-only reader over four kinds is a small fraction of that, and the behaviour worth keeping is in the schema, which we do take.

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
