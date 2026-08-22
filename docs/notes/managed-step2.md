# Step 2: install + update check (runtime-install.ts)

## Status
Done. Build clean, 161/161 tests passing (150 from step 1 + 11 new).

## Branch / commits
`feat/managed-runtime`, `68cc8e1` — adds `src/main/runtime-install.ts` and
its spec, and exports `envWithLauncherDir` from `server.ts` for reuse.

## What was built
`resolveVersion`, `isInstalled`, `ensureInstalled`, `latestVersion`,
`updateAvailable`, all taking an injected `InstallDeps` (`run`/`exists`/`mkdir`).
No interface names changed from the sketch. `ensureInstalled` reuses
`envWithLauncherDir` (newly exported from `server.ts`) rather than
duplicating the npm-needs-node-on-PATH fix.

## Vacuity check on the skip test
Removed the `if (isInstalled(...)) return` guard in `ensureInstalled`, reran
`skips the install entirely when the version is already installed`: it
failed (`TypeError: Cannot read properties of undefined (reading 'code')`,
because the fake `run` mock has no default return and is only ever
configured in tests that expect it to be called). Restored the guard; the
full 161-test suite passed again. Confirms the skip test is non-vacuous.

## Real end-to-end verification
Ran the actual install of `@deepseek-ai/dsh@0.1.1-rc.2` into the real
`~/.dsh` through `ensureInstalled` (via a small driver script backed by real
`node:child_process`/`node:fs`, not a hand-typed npm command), foreground,
600000ms timeout:
- Cold install: **375.9s** (`added 455 packages in 6m`).
- Second `ensureInstalled` call for the same version: **0s**, `npm` never
  invoked (confirmed no output/spawn beyond the isInstalled check).
- `isInstalled` reported `true` afterward.
- `~/.dsh/runtimes/%40deepseek-ai%2Fdsh/0%2E1%2E1-rc%2E2/node_modules/.bin/dsh --version`
  printed `0.1.1-rc.2`.

## Constraints verified
- `git status --porcelain` in `deepseek-harness` — clean throughout.
- `grep -rn "/Users/" src/ tests/` in `dsh-desktop` — no matches.
- Only `~/.dsh/runtimes/` was created; `settings.yaml`, `sessions/`,
  `storages/`, `profiles/`, `desktop.json` untouched.
