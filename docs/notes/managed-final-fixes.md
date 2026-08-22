# Managed runtime: final review fix wave

Fixes for the last review of `feat/managed-runtime`. The reviewer's structural diagnosis is the organising idea: this branch turned Save into a six-minute async operation and then reasoned about quit only at the *config-write* boundary, never at the *process* or *re-entrancy* boundaries.

## Critical 1 — a synchronous throw in the update check broke the repair screen

`read()`'s dependency arrow calls `resolveBinary(npmPath, 'npm', process.env)`, which throws `ConfigurationError` when PATH is system-only and `npmPath` is unset. The throw happened before a promise existed, so the `.catch()` chained onto the result never attached: it escaped `read()`, rejected `ipcMain.handle('settings:read')`, and reached a renderer `load()` with no catch. Managed source, packaged app launched from Finder, `npmPath` unset: boot fails, Settings opens, and Settings renders blank with the local radio checked — the screen that exists to repair a bad config, broken by that config.

`createSettingsHandlers`'s `read` now wraps the call itself in `try`, not only its promise, so both failure modes degrade to "no update information". The `checkManagedUpdate` doc says so: it may fail by rejecting *or* by throwing synchronously, and `read` treats both as `undefined`.

`settings.js`'s `load()` gains a failure path. A rejected read leaves the status line saying the settings could not be read, with the underlying message, and the intro saying that saving will replace the stored configuration rather than edit it. Save stays enabled deliberately: a failed read means the config is unreadable, and this window is where it gets repaired.

## Critical 2 — the npm child outlived quit

`runInstallCommand` spawned npm without `detached`, tracked it nowhere, and `shutdown()` reaped only the harness child and awaited `transition`. The install was in neither. First run, managed source, Save, six-minute cold install, user closes Settings: nothing is configured, so the app quits. The post-install `isQuitting()` re-check correctly suppressed the config write — and the Electron process exited while npm kept running for minutes, reparented, still writing into `~/.dsh/runtimes`.

The npm child now gets exactly what the harness child gets. `src/main/install-process.ts` owns it: detached spawn so it leads its own process group, tracked in a set from spawn to exit, and killed through the existing `stopGroup`, which is exported from `server.ts` rather than duplicated. `shutdown()` calls `installs.stopAll()` first and unconditionally — the install is in neither the lifecycle chain nor `child`, so nothing else on the quit path would find it. Killing it is also what makes the in-flight save's install reject, so that save unwinds instead of finishing behind the quit's back.

A killed install must not later look complete. `isInstalled` checks the linked binary rather than the directory, but npm links `node_modules/.bin` before the dependency tree is fully written, so that check alone cannot tell a killed install from a finished one. `ensureInstalled` now installs into a `.partial` staging sibling (`managedStagingDir`) and renames it into place only on success — a filesystem-atomic step rather than a check. Staging residue from an earlier killed attempt is removed before a new one starts. Cleanup-on-failure was rejected as the primary mechanism because it cannot be relied on to run while the process is exiting.

## Important 3 — concurrent saves were reachable

`performSave` guarded only via `save.disabled`, and the "use latest" action is never disabled; an update lookup racing a minutes-long install can un-hide the hint mid-install. Closing and reopening Settings mid-install reaches the same place, since the fresh window's Save starts enabled.

Saves are serialized in **main**, using the `singleFlight` helper this codebase already has. A call arriving during a run starts nothing and resolves with the running save's outcome, so there is one `npm install --prefix`, one `writeConfig`, one `applySettings`. `singleFlight` takes no arguments, so the form travels through two variables the run reads synchronously — `singleFlight` invokes the wrapped function before `save()` returns, so a run always sees the form of the call that started it.

## Important 4 — progress cross-talk after reopen

Chosen: **progress reaches only the window that started it.** `settings-window.ts` pushes to the `WebContents` that invoked the channel (`event.sender`), not to whatever settings window is current. A reopened window showing an idle Save is honest about itself; making it also stream another window's output would be actively misleading, and a destroyed sender drops the line the same way the old window check did.

## Minor 5 — timeouts

Both npm invocations are bounded, in the runner that owns the process.

- `npm view`: **60s**. One registry request for one field, on the path that opens Settings and the path that saves it. A registry that accepts the connection and then stalls would otherwise leave Save disabled with no way out.
- `npm install`: **900s** (15 minutes). The measured cold install of this dependency tree — 62 direct workspace dependencies whose transitive tree builds node-pty, sharp, and koffi — is about 375 seconds; a warm one is skipped entirely by `isInstalled` (0s). Fifteen minutes is roughly 2.4x the measured cold figure, which leaves room for a slow network or a slower machine while still bounding a hang.

A run that outlives its bound has its process group killed first and then rejects naming the limit, so a hung registry cannot leave npm running after the caller has given up on it.

## Minor 7 — docs

The two `docs/decisions.md` entries asserting the `--` separator and the npx design as current are marked superseded, with what replaced them. The 375-second measurement in the second entry is kept — it is the number `INSTALL_TIMEOUT_MS` is set against.

## Not in scope

`updateAvailable` stays bare inequality rather than semver ordering; it is deliberate and documented at the function.

## Tests, and what the vacuity checks showed

Findings 1–4 all gained covering tests, and both Criticals were proven non-vacuous by reverting the fix and confirming the failure.

- **Critical 1**: removing the synchronous `try` from `read` failed both new `settings-ipc` tests ("still returns the stored form when checkManagedUpdate throws synchronously", "never reports an update when the lookup throws synchronously"); restoring it returned the file to 24 passing.
- **Critical 2**: `install-process.spec.ts` drives real processes rather than a fake `spawn`, because the property under test is that quitting actually reaps the install — a mock can only show that a function was called. The child prints its own pid and a grandchild's, and the test asks the operating system whether they are gone. Removing `detached: true` and the tracking set failed both "kills an in-flight install and its whole process group" and "kills a run that outlives its bound"; the group-kill test failed only after its 30-second bound, with the processes still alive, and the reverted run left a grandchild behind on the machine — the leak the fix exists to prevent. Restoring returned the file to 8 passing.

`index.spec.ts` covers the wiring — quit reaches `stopAll`, and reaches it before `app.quit()` — while the reaping itself is proven against real processes. `settings-window.spec.ts` now records which renderer each pushed line reached, so the cross-talk test can assert that a reopened window receives nothing.

## Re-review residuals

Two residuals came out of the re-review that confirmed the wave above. Both are boundaries the first pass reasoned about one step too early.

### The rename had no target to rename onto

`ensureInstalled` renamed the `.partial` staging directory onto `managedDir`, and `renameSync` fails with `ENOTEMPTY` when the target exists and is non-empty. That state is reachable: an install killed by a build from before the staging fix, or any package that links no `dsh` bin, leaves a non-empty `managedDir` whose `managedBin` is absent. `isInstalled` correctly says "not installed", the install runs, the rename fails — and it surfaces as an opaque error on the version field that **every retry reproduces identically**, with no way to recover from inside the app.

The target is now removed immediately before the rename, so a retry always converges. Two properties bound what that removal can do. It is the derived `managedDir` for that exact package and version, never a parent — asserted by a test that checks every `rm` call against the two permitted paths. And it runs only after the staging install has already succeeded, so the replacement is on disk before anything is deleted: deleting a working install and then failing to produce one would be worse than the bug. A separate test pins that a failed install never removes the target.

### Joining was the wrong semantics for a save

`singleFlight` hands the second caller the run already in flight, so a second save received the *starter's* outcome. The previous round's own test pinned it: a save of `0.2.0` was told `{ok: true}` by an install of `0.1.1-rc.2`. Concretely, a reopened Settings window switches to a local checkout, clicks Save, and reads "Settings saved." while a managed config is applied instead — the user's intent silently dropped, and the success message removing the one cue that would make them retry.

Joining is right for idempotent work like the tray's Restart, where every caller wants the same outcome. Each save carries its own values, so the second is now refused rather than joined, with `kind: "A save is already running; wait for it to finish and try again."` The serialization itself is unchanged and still asserted: one `npm install --prefix`, one `writeConfig`, one `applySettings`.

The renderer routes a `kind` error to the status line instead of a field node. `kind` is not a value the user corrects — the source is a radio pair — and this class of error rejects the whole save rather than naming a bad input, so it belongs beside the Save button that produced it, where "Settings saved." and the save-failed message already appear. The now-unused `error-kind` node is gone from the markup, and `clearStatus` already clears where the message lands. Real field errors still go to their own fields, which a test pins so the two paths cannot collapse into one.

### What the vacuity checks showed

- **Rename target**: dropping the `deps.rm(dir)` line failed "recovers a leftover install directory that has no linked binary", with the promise rejecting `ENOTEMPTY: directory not empty` instead of resolving — the user-facing failure exactly. Restoring returned the file to 18 passing.
- **Save semantics**: restoring the joining behaviour (the second caller awaiting the run in flight) failed both "refuses a second save instead of reporting the first one's outcome as its own" and "never applies the values of a save it refused"; the first only after its 30-second bound, because under joining the second caller blocks on an install that never finishes rather than being answered. Restoring returned the file to 24 passing.
