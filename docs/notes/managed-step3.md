# Step 3: settings-window wiring for managed installs

## Status
Done. Build clean, 181/181 tests passing (166 before this step's own
additions on top of step 2's 161, plus 15 new: `managed-install.spec.ts`
composition tests, `settings-window.spec.ts` push-channel tests, and new
cases added to `settings-ipc.spec.ts` and `settings.spec.ts`).

## What was built
- `settings-ipc.ts`: `save` for a managed source now resolves the version/tag
  and installs via a new `installManaged` dep, stores the concrete version,
  and re-checks `isQuitting()` after the (potentially minutes-long) install
  before writing. `read` takes an optional `onUpdateAvailable` callback,
  firing a background `checkManagedUpdate` and swallowing its rejection.
- `src/main/managed-install.ts` (new): `createManagedInstaller` and
  `createUpdateChecker`, composing step 2's `runtime-install.ts` functions
  over injected `InstallDeps` — kept separate from `settings-ipc.ts` so both
  are unit-testable without Electron.
- `settings-window.ts`: wires `settings:save`'s progress callback and
  `settings:read`'s update callback to `webContents.send`, guarded by the
  existing `isOpen()` check.
- `preload/settings.ts`: added `onProgress`/`onUpdateAvailable`, both
  receive-only (`ipcRenderer.on` + an unsubscribe function) — no new
  `invoke` channel.
- `index.ts`: real `InstallDeps` (`runInstallCommand` over
  `child_process.spawn`, `existsSync`, `mkdirSync`) wired into
  `installManaged`/`checkManagedUpdate`, both resolving `npmPath` via the
  existing `resolveBinary`.
- Renderer: radio value/label `npx` → `managed`/"A managed install", field id
  `npxPath` → `npmPath`, a `#progress` `<pre>` that streams install lines and
  clears per save, and an `#update-hint` banner with a "Use it" button that
  fills the version field and calls the same `performSave()` path.

## Vacuity checks
1. **"skips npm install entirely when the resolved version is already
   installed"** (`managed-install.spec.ts`): removed the
   `if (isInstalled(...)) return` guard in `runtime-install.ts`'s
   `ensureInstalled`. Result: failed —
   `expected "spy" to be called 1 times, but got 2 times`. Restored the
   guard; the two-file suite (16 tests) passed again.
2. **"stays silent when the update lookup fails"** (`settings-ipc.spec.ts`):
   removed the `.catch(() => {})` around `checkManagedUpdate` in `read`.
   Result: failed — vitest reported an unhandled rejection
   (`Error: registry unreachable`) and exited 1. Restored the catch; the
   19-test file passed again.

## Real end-to-end verification
GUI automation was available (Playwright's Electron driver, already a
devDependency). Packaged the app (`npm run pack`) and drove the real
`.app`:

1. Launched with an isolated `--user-data-dir` (matching the smoke test's
   isolation); `~/.dsh/desktop.json` itself is not affected by that flag, so
   this exercised the real config location.
2. Opened Settings via the application menu, switched the radio to managed,
   left package/version blank, clicked Save.
3. Confirmed `~/.dsh/desktop.json` was rewritten with
   `"version": "0.1.1-rc.2"` (the concrete version `npm view` resolved
   `latest` to, matching the version already under
   `~/.dsh/runtimes/%40deepseek-ai%2Fdsh/`) rather than the tag `latest` —
   proving resolve-then-store end to end through the real save path.
4. Relaunched (config now managed) and confirmed the managed binary was
   actually spawned: the failure page's stack trace resolved entirely inside
   `~/.dsh/runtimes/%40deepseek-ai%2Fdsh/0%2E1%2E1-rc%2E2/node_modules/...`,
   i.e. exactly the path `managedDir`/`managedBin` compute, and got as far as
   the harness's own `cordis-plugin-loader` applying the `web` profile.

**Finding, out of scope to fix**: the managed launch then failed inside the
harness itself — `~/.dsh/profiles/web`'s `dsh-hooks-claude-code` plugin
cannot resolve `@deepseek-ai/dsh-hook-protocol`, because that profile's
`node_modules` was built assuming pnpm's workspace-symlink resolution (set
up under local-checkout mode per this README's own turn-completion-hook
instructions) and a plain-npm managed install resolves modules differently.
Confirmed this is unrelated to this step's code, not a regression: the same
launch with `desktop.json` reverted to local mode boots clean (title "DSH
Local Build") using the identical `~/.dsh/profiles/web`. Fixing it would mean
writing into `~/.dsh/profiles/`, which is explicitly off-limits here, so it
is left as a known gap for whoever re-runs
`pnpm dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code` under
a managed install.

`~/.dsh/desktop.json` was set back to local mode immediately after, content
and md5 (`aab7d246b3afc2671317f09bffd86158`) identical to the pre-task
capture.

## Constraints verified
- `git status --porcelain` in `deepseek-harness` — clean throughout and at
  the end.
- `grep -rn "/Users/" src/ tests/` in `dsh-desktop` — no matches.
- `~/.dsh` — only `desktop.json` was ever written by this work (and restored
  to its original local-mode content/md5); `settings.yaml`, `sessions/`,
  `storages/`, `profiles/` untouched.
