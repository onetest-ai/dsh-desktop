# Step 1: managed runtime core (harness-source.ts)

## Status
Done. Build clean, all tests passing.

## Branch / commit
`feat/managed-runtime` at `a360334c5d466a864ccd2f46abeb4863bb556aad`
(base `main` was `4d798fa`).

## Build + tests
- `npm run build` — clean (tsc + renderer copy).
- `npx vitest run` — 140/140 passed across 11 test files (was 136; net +4 after
  converting the npx-mode tests to managed-mode ones and adding
  `managedDir`/`managedBin` coverage).

## Directory-naming scheme
`managedDir(dshHome, pkg, version)` = `$DSH_HOME/runtimes/<encodeURIComponent(pkg)>/<encodeURIComponent(version)>`.
Percent-encoding is injective (distinct inputs never collide) and escapes `/`
to `%2F`, so the package segment can never itself contain a path separator.
Nesting package and version as two separate encoded segments, rather than
joining them into one with a hand-picked delimiter, means no delimiter has to
be proven unambiguous. `managedBin(dir)` = `<dir>/node_modules/.bin/dsh`.

## The `--` separator
Removed entirely. It existed only because `npm exec` (modern `npx`) otherwise
swallowed `--profile`/`--patch`/`--no-open` as its own CLI flags. The managed
arm now runs the installed `dsh` binary directly — no wrapper CLI parses args
in front of it — so nothing consumes the profile flags before `dsh` sees
them. The local arm (`pnpm dsh ...`) never needed it either. No source kind
needs a `--` separator anymore.

## PATH vacuity check
Temporarily changed `dshWebCommand` to prepend the managed spec's own command
directory (as it originally did for launchers) instead of the resolved `npm`
binary's directory, and reran the two new PATH-prepend tests:
- Both failed, e.g. expected `/^\/usr\/local\/bin:/` but got a PATH starting
  with `/tmp/dsh-home/runtimes/%40deepseek-ai%2Fdsh/latest/node_modules/.bin:...`
  (the installed binary's own `.bin` directory, not npm's).
Restored the fix (prepend `dirname(resolveBinary(config.npmPath, 'npm', ...))`
for a managed source); both tests pass again. Confirms the tests are
non-vacuous.

## Other changes forced by the type change
`HarnessSource`'s `'npx'` kind became `'managed'` and `Launchers` dropped
`npx()` (spawnFor no longer resolves any binary for the managed arm — it
derives the path from `dshHome` alone). To keep `npm run build` and
`npx vitest run` green, this also touched `config.ts` (kind validation,
`npmPath` field), `preflight.ts` (kind check), `index.ts`
(`harnessSourceChanged` switch, `needsRestart` field, `dshWebCommand` call
site), and `server.ts` (`dshWebCommand`'s PATH-directory selection), plus
their spec files. `src/renderer/settings.{html,js}` (the Settings UI) is
intentionally untouched — it is step 3's scope and isn't type-checked by
`tsc`, so it stayed green.

## Constraints verified
- `git status --porcelain` in `deepseek-harness` — empty.
- `grep -rn "/Users/" src/ tests/` in `dsh-desktop` — no matches.
- No writes to `~/.dsh`; all new/changed tests use string-only path
  computation or explicit temp directories (`DSH_HOME = '/tmp/dsh-home'` is
  never created on disk, only used for path-string assertions).
