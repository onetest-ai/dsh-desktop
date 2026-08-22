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

## Fix round: directory-traversal hardening + README (2026-08-22)

### Finding 1 — `managedDir` traversal/collision, fixed
`encodeURIComponent` leaves `.` unescaped (it's an unreserved character), so a
`version`/`package` of exactly `..` — or ending in `..` — survived into a
real `path.join` component and got collapsed as "go up a directory".
Confirmed both of the review's reproductions against the *old* derivation:
- `managedDir(home, 'a', '..')` → `home/runtimes` (collapses onto the
  runtimes folder itself, not a subdirectory of it).
- The specific pair `managedDir(home, 'a', '../b/1.0.0')` vs
  `managedDir(home, 'b', '1.0.0')` does **not** actually collide under the
  exact old code, because `encodeURIComponent` already escapes the `/`
  *inside* `../b/1.0.0` to `%2F`, leaving one opaque segment
  (`..%2Fb%2F1.0.0`) that `path.join` never treats as a dot-component. The
  same root cause (a bare, unescaped `..`) does produce a genuine collision
  between distinct inputs when the *whole* version is `..`:
  `managedDir(home, 'a', '..')` and `managedDir(home, 'z', '..')` both landed
  on `home/runtimes`. The test suite keeps the review's literal pair as a
  regression guard and adds this pair as the actual non-vacuous collision
  proof — see the vacuity section below.

**Derivation chosen**: `encodeSegment(value)` = `encodeURIComponent(value)`
with every literal `.` additionally replaced by `%2E`, and the empty string
mapped to the literal `%00`. This is traversal-safe for *any* input:
`encodeURIComponent` already guarantees no unescaped `/`; the `.` → `%2E`
substitution additionally guarantees the segment can never literally equal
`.` or `..` (both would require a literal `.` character, which no longer
survives), and it stays unambiguous because `encodeURIComponent` never itself
emits the substring `%2E` — the only byte whose hex pair is `2E` is `.`
itself, which is unreserved and therefore always left as a literal `.`, not
escaped. The empty-string case is handled separately since
`encodeURIComponent('')` is `''`, which would otherwise vanish as a
`path.join` argument. `managedDir` and `managedBin` are otherwise unchanged.

**Defense in depth**: `settings-validate.ts` now also rejects a `package`
that doesn't look like an (optionally scoped) npm package name, and a
`version` that doesn't look like a version or dist-tag, with per-field
errors in the same voice as the existing checks — so a traversal-shaped
value from the Settings form is rejected before it ever reaches
`managedDir`, independent of the structural fix.

### Vacuity check (restored old `encodeURIComponent`-only derivation, reran, restored fix)
With the derivation temporarily reverted to
`join(dshHome, RUNTIMES_DIR_NAME, encodeURIComponent(pkg), encodeURIComponent(version))`:
- `keeps a ".." version strictly inside the runtimes directory...` — **failed**
  (`dir` equaled the runtimes directory itself instead of a subdirectory of it).
- `gives two distinct package/version pairs that both end in a literal ".." different directories` — **failed**
  (`managedDir(home,'a','..')` and `managedDir(home,'z','..')` both produced
  `home/runtimes`).
- Three of the five hostile-input cases (`..`, `../x` — via a different
  escape path — and `''`) also failed under the old derivation; `a/b` and
  `%2e%2e` already happened to be safe under `encodeURIComponent` alone.
Restored `encodeSegment`; all 23 `harness-source.spec.ts` tests (and the
full 150-test suite) pass again.

### Finding 2 — README, fixed
Updated the Requirements, First run, Settings (table, JSON schema example,
and the PATH-prepend explanation), and Known Limitations sections to say
`"kind": "managed"` / `npmPath` and to correctly attribute the PATH prepend
to `pnpm`'s own directory for a local source vs. the resolved `npm`
binary's directory for a managed source (not "that path's own directory"
in both cases, which was only ever true for the local arm).

### Build + tests after the fix round
- `npm run build` — clean.
- `npx vitest run` — 150/150 passed across 11 files (was 140 before this
  round; +10 from the new `managedDir` traversal tests and the two new
  `settings-validate` rejection tests).

### Constraints reverified
- `git status --porcelain` in `deepseek-harness` — empty.
- `grep -rn "/Users/" src/ tests/` in `dsh-desktop` — no matches.
- No writes to `~/.dsh`; new tests use string-only path computation.
