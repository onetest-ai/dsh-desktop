# The git panel

A source-control view on the rail: the repos in the project, the files that have changed, and the diff for one of them — with staging, committing, and the remote operations that go with them. Local git only. No GitHub account, no API, no tokens.

## The `git` binary, not a library

Every operation shells out to the user's own `git`, found through the login-shell `PATH` this app already resolves and caches. A JavaScript reimplementation would diverge from whatever their git actually does with hooks, LFS, submodules, `core.autocrlf`, and every option in their config — and it would diverge silently, which is the worst way. VS Code shells out for the same reason.

`git` missing from `PATH` is a state the panel reports, not one it works around.

## Where it lives

The panel shares the side column with the file tree, the way Explorer and Source Control take turns in one VS Code sidebar. `rail-git` puts the git page in that column; pressing it while git is showing closes the column, and pressing it while the tree is showing switches.

Not a fourth column. Two views that are rarely read at once do not both deserve permanent horizontal space on a laptop, and `Columns` keeps its existing shape — `files` becomes the side column with a stored choice of view rather than gaining a sibling.

It carries a shortcut of its own, `⌘⌥G`, alongside `⌘⌥B` for the tree, `⌘⌥W` for the browser, and `⌘⌥J` for the terminal — registered on a menu item, since an accelerator exists nowhere else.

New: `views.git`, a `git.html` page with its own bundle, beside `files` and `terminal`.

### When there is nothing to show

Three states are not failures and are worded as such: the project holds no repository at all; the repositories are clean; and `git` is not on the `PATH`. The last names the setting that fixes it, the way a missing `pnpm` already does.

## The model is in main

Following the grain of `file-tree.ts` and `browser-actions.ts`: main turns bytes into structure, the renderer draws what it is given. The parsing is where the bugs are, and main is the half that tests without Electron.

**`git-run.ts`** — the only place a git child is spawned. Takes a working directory and arguments, returns exit code, stdout, and stderr. Carries the environment described under *Failing loudly*, and a timeout.

**`git-find.ts`** — locates the binary, and discovers repos: the project root, plus one level below it, skipping `node_modules` and `.git`. One level is VS Code's default scan depth and it covers the case that prompted this — a project holding several checkouts. Deeper scanning wanders into vendored trees for results nobody wanted.

**`git-status.ts`** — pure. Takes the bytes of `git status --porcelain=2 -z --branch` and returns structure. Spawns nothing, so it is table-driven against recorded output.

Nothing about git reaches the renderer.

### What a repo looks like to the panel

Its path, a display name, the branch, ahead and behind counts, and three groups of entries: **staged**, **changed**, and **untracked**. An entry is a path, a status letter, and — for a rename — the path it came from.

## Refresh

Git state moves for three reasons: the user acting in the panel, the agent working in the terminal or through its own tools, and anything at all outside the app. Only the first is observable directly, so the other two are watched for.

Status is recomputed when the panel opens, when an action in it completes, when the window regains focus, when the project changes, and when a repo's `.git/index`, `.git/HEAD`, or `.git/refs` changes — debounced, through the same watcher mechanism the tree already uses. There is no polling.

Refreshes are serialised per repo, and a refresh already running is superseded rather than queued. An agent running a rebase in the terminal panel will otherwise fire dozens of them in a second.

## The panel

A commit message box at the top, with the branch name and sync counts above it. Then one collapsible group per repo — collapsed away entirely when only one repo was found, since the common case deserves no ceremony — and inside each, up to three sections: **Staged Changes**, **Changes**, **Untracked**.

A row is a checkbox, a status letter, the filename, and the directory dimmed after it, coloured by status: green added, amber modified, red deleted, grey untracked. In the harness's own tokens, following its Appearance setting, like every other surface this app draws.

### The checkbox is a selection, not the index

Ticking a file does not stage it. The tick says only *include this in the next commit*, and nothing runs until Commit is pressed. Each section header carries a tick of its own that selects or clears everything under it.

**Tracked changes start ticked; untracked files start unticked.** Committing a file you had not noticed is how build output, local scratch files, and credentials end up in a repository, and an untracked file is by definition one git has never seen before.

A file that was staged and then edited again appears in both **Staged Changes** and **Changes**, as it does in VS Code, with a tick in each. They mean different content: the staged row is the version already recorded, the changed row the edits made since.

## The diff

Clicking a row shows that file's diff in the editor column, rendered inline — one pane, not two. Which sides are compared depends on which section the row was in, as it does in VS Code:

| Row in | Diff shows |
| --- | --- |
| Changes | index against working tree |
| Staged Changes | `HEAD` against index |
| Untracked | empty against working tree |

Main produces both sides with `git show :path` and `git show HEAD:path`, and by reading the file for the working-tree side.

Two things about the existing diff surface have to change.

**The sides are the other way round.** `Editor.showDiff(file, proposed)` reads disk as the *original* and treats its argument as the modification, because it was written for an agent proposing a change to a file that exists. Git needs the opposite. Opening a diff is generalised to take both texts explicitly, and the agent's `show_diff` becomes one caller of that rather than its only shape.

**A git diff must not evict the tab you are editing.** `showDiff` currently drops the file's existing tab, and refuses outright when it is dirty:

> `${file.relative} has unsaved edits, so the proposed change was not opened.`

That is the right rule for an agent's proposal — it protects work the user has not saved. It is the wrong rule here, because a file with unsaved edits is exactly when its diff is most worth seeing. Diff tabs therefore get their own identity: a file may have an editor tab and a git diff tab open at once, and opening the diff neither closes the other nor refuses because of it.

Inline rendering is `renderSideBySide: false`, set per tab rather than globally, so the agent's proposal view keeps whatever suits it.

## Acting on a repo

Per row, on hover and in the right-click menu: **Stage**, **Unstage**, **Discard**. Per repo header: **Stage All**, **Unstage All**, **Discard All**.

**Discard is unrecoverable.** `git checkout --` throws work away with nothing in the reflog to bring it back. It is confirmed, naming the file — the way Delete in the tree already is — and Discard All names the count. This is the most dangerous control in the panel and is deliberately the most annoying.

Staging and unstaging by hand remain, for the times the index is what you are thinking about; they are the same operations Commit performs for you, and the panel is consistent either way because the tick never claimed to be the index.

Every action refreshes its own repo and nothing else. A git failure is reported as the repo's name and the first line of stderr — never a stack trace, the same rule the tray note follows for a plugin that would not load.

## Committing

Commit does the staging for you. There is no separate step, and it is never refused for having nothing staged — with a message written and something ticked, it commits.

What it does, in order:

1. `git add --` the ticked paths that are not already staged;
2. `git reset --` any path that *is* staged but is not ticked;
3. `git commit`.

Step 2 is the one to understand. Without it, a file staged earlier and then unticked here would still be committed, because `git commit` commits the whole index. So the index is reconciled to the selection rather than left alone — **and it stays that way afterwards.** Unticking a staged file unstages it for good, not just for this commit. That is the honest cost of a tick that means something different from staging, and it is stated here rather than discovered.

The button is disabled only when the message is empty or nothing is ticked, which are both simply nothing to do.

## The remote

The repo header carries the branch and its `↓2 ↑1`. Behind a menu: **Fetch**, **Pull**, **Push**, each doing exactly one thing.

Not a combined Sync. Sync is pull-then-push, and a compound operation that half-succeeded is one the panel then has to explain. Pull respects the user's own `pull.rebase` rather than imposing merge or rebase on them. Push is plain `git push` — never `--force`, behind no modifier, at no point.

Each is serialised per repo, shows that it is running, times out, and can be cancelled by killing the child.

## Failing loudly

Every git child runs with:

- `GIT_TERMINAL_PROMPT=0`, so git cannot block waiting on a terminal that does not exist;
- `GIT_SSH_COMMAND` carrying `-o BatchMode=yes`, so ssh fails rather than asking for a passphrase;
- `SSH_ASKPASS_REQUIRE=never`, so it does not raise a GUI prompt instead;
- no `GIT_ASKPASS` of this app's own.

All four matter. Without the second and third — the ones most easily forgotten, and the common case on a developer's machine — an unattended git hangs forever holding the panel open on a spinner.

The app deliberately has no askpass of its own. Passphrases and tokens would then pass through it, which is precisely what the MCP credential decision avoided, and it is a subsystem in its own right. The cost is stated rather than hidden: **a repo whose credential is not already cached cannot push from the panel.**

The four failures that actually happen are recognised and translated rather than pasted:

| What git says | What the panel says |
| --- | --- |
| `could not read Username` | it needs an HTTPS credential it does not have |
| `Permission denied (publickey)` | the SSH key is not loaded in the agent |
| `Host key verification failed` | the host is not in `known_hosts` yet |
| `Authentication failed` | the stored credential was rejected |

Each names the repo and offers **Open in Terminal**, which opens the terminal panel in that repo's directory. Run it once by hand, let git's own credential helper cache what it needs, and the panel works from then on. That escape hatch is what makes failing loudly acceptable, and it exists because the terminal shipped in 0.3.0.

## Testing

The hard parts are pure functions, so they test without Electron alongside the rest of the main-process suite.

- **`git-status.ts`** carries the bulk: table-driven against real `--porcelain=2 -z` bytes — NUL splitting, rename records carrying two paths, unmerged states, untracked against ignored, and the branch header's ahead and behind counts.
- **`git-find.ts`** against temporary trees: a root that is a repo, a root that is not but whose children are, a nested `node_modules` skipped, and no repos at all.
- **`git-run.ts`** against a real git in a temporary repo, asserting the environment above actually reaches the child. Skipped with a stated reason when git is not installed.
- **Grouping and sorting** for the panel, which are pure.
- Each parser is broken deliberately to confirm its test fails, as this project asks of a test that guards something important.

Not added to the packaged smoke test, which exercises startup and would need fixtures to say anything here.

## Deliberately not in this

Branch switching and creation, merge conflict resolution, stash, history and blame, submodules, commit amend, and force push. Each is a design of its own; none is assumed by anything above.
