# Smoke test isolation, and tabbed Settings

Two changes on `feat/plugin-rows`: the packaged smoke test now provisions its
own `$DSH_HOME` instead of reading the developer's real `~/.dsh`, and the
Settings window is reorganised from one long scroll into four tabs.

## Smoke test isolation

`tests/smoke.spec.ts` isolated `--user-data-dir` but not `$DSH_HOME`. The
app's config lives at `$DSH_HOME/desktop.json`, so with `~/.dsh` cleared for a
first-run test, the packaged app correctly opened Settings instead of booting
a harness, and the test timed out waiting for a `127.0.0.1` URL. This was
diagnosed, not assumed: giving the packaged app a temp `$DSH_HOME` with a
valid `desktop.json` (local source pointing at the sibling `deepseek-harness`
checkout, `pnpmPath` from `which pnpm`) launches it normally.

The fix: `provisionDshHome()` builds a fresh temp directory holding a
`desktop.json`, following the existing `--user-data-dir` pattern, and passes
it as `DSH_HOME` in `electron.launch`'s `env`. The harness checkout path is
derived from `tests/smoke.spec.ts`'s own location
(`join(__dirname, '..', '..', 'deepseek-harness')`) rather than hardcoded —
`dsh-desktop` and `deepseek-harness` are sibling checkouts, the convention
already documented in `docs/superpowers/plans/2026-08-21-dsh-desktop.md`. The
`PATCH_MARKER` orphan check and the packaged-artifact assertions are
untouched.

## Tabs

Settings' four groups — harness source, plugins, notifications/shortcuts,
advanced binary paths — are now tabs: **Harness**, **Plugins**,
**Notifications & Shortcuts**, **Advanced**. The grouping in the brief was
used as-is; it maps one-to-one onto the window's existing `section.group`
cards, so no group had to be split or merged.

Tabs use real ARIA semantics: `role="tablist"`/`role="tab"`/`role="tabpanel"`,
`aria-selected`, `aria-controls`/`aria-labelledby`, and a roving `tabIndex`
(only the active tab is in the Tab order). Click or Arrow/Home/End selects a
tab immediately (WAI-ARIA "automatic activation"); arrows wrap at the ends.
All of this lives in `settings.js` as plain DOM calls — no framework.

### Errors in an inactive tab

A save can reject a field whose tab is not the one open (e.g. `hotkey` fails
while the user is looking at Plugins). `performSave` now maps each field name
to its owning tab (`FIELD_TAB`) and, after setting every error message as
before: (1) puts a small dot on the tab button of every tab holding a live
error (`markTabError`), and (2) if the currently active tab holds none of the
errors, switches to the tab owning the first one, without stealing focus from
the Save button (`selectTab(id, { focus: false })`). The dot means an error on
a *second* affected tab stays discoverable even after the switch lands on the
first one; the switch means the common case (one bad field) needs no extra
click. Dots are cleared at the top of every `performSave` attempt.

Verified non-vacuous: reverted the two lines that call `selectTab` on a
cross-tab error, ran
`npx vitest run src/renderer/settings.spec.ts -t "switches to that tab"` —
failed (`expected 'harness' to be 'notifications'`) — then restored them and
confirmed all 44 renderer tests pass again.

### Styling

`.tabs`/`.tab` were tried first as an equal-width segmented control (mirroring
a macOS System Settings-style control) but at this window's width that
truncates "Notifications & Shortcuts" mid-word. Switched to an underline tab
bar instead: auto-width buttons, `--accent` underline and text color on the
selected tab, `--label-secondary` otherwise, `--accent` focus ring on
`:focus-visible` — reusing exactly the tokens already mirrored from
`packages/client/ui-theme/src/styles/design-platform.css` in this file, so it
reads as part of the same system in both themes rather than a new widget. The
now-unused `<details>`/`summary` disclosure styling (Advanced no longer needs
it, since it is its own tab) was removed rather than left dead.

### Window size

Grew from 620x640 to **640x720**. Measured each tab's content height via
`getBoundingClientRect()` on a stub-`window.settings` copy of
`dist/renderer/settings.html` served over a local HTTP server: the tallest
state is the Harness tab with "A managed install" selected and an update hint
showing (~546px); Plugins with four rows, including a long scoped name, is
close behind (~526px) but is capped by `.plugin-rows`' own internal
`max-height: 220px` scroll regardless of row count, so it can never exceed
that. 640x720 clears the tallest state with room to spare in both themes.

## Rendering, actually checked

Served `dist/renderer/settings.html` (via a local `preview.html` in the
gitignored `dist/renderer/`, stubbing `window.settings` with a configured
local source and four plugins — one with a long scoped name,
`@some-very-long-scope-name/some-really-quite-long-package-name-for-testing-ellipsis`
— to render the page without Electron) over a local HTTP server, resized the
Browser pane to 640x720, and inspected every tab in both `light` and `dark`
`prefers-color-scheme`:

- **Harness**, local source: radio group, checkout folder input, error slot.
  Switched to "A managed install" and revealed the update hint: package,
  version, "Use it" hint, workspace row all render, fits with room below Save.
- **Plugins**: four rows rendered as cards-in-a-card; the long scoped name
  truncates with an ellipsis before the "Remove" button, which stays flush
  right on every row; the pinned/version/installed metadata line wraps
  correctly for each state (pinned vs. floating, installed vs. not yet).
- **Notifications & Shortcuts**: port and shortcut fields, well short of the
  window height.
- **Advanced**: pnpm/npm path fields, same.

In dark mode the surfaces, borders, and the active tab's underline/text color
all switched correctly via the existing `prefers-color-scheme` block; no
element stayed on its light value. The preview file was removed after
inspection (gitignored `dist/`, never committed).

## Verification

- `npm run build` — clean.
- `npx vitest run` — 310 passed (was 301; +9 tab tests, unchanged elsewhere).
- `npm run pack && npm run test:smoke` — packaged and the smoke test passed
  genuinely, with `~/.dsh` absent throughout.
- `grep -rn "/Users/" src/ tests/` — empty.
- `git -C ~/Development/deepseek-harness status --porcelain` —
  empty throughout.

## Review follow-up: renderer state reconciliation

Moving the plugin list into renderer state (`pluginRows`) introduced a bug
class the old `<textarea>` did not have: the list is authoritative in the
renderer between reads, and three paths mutate it — Add, Remove, and accept-
update's former `load()` — without being reconciled against what Save
actually persists. Six findings, fixed in place on `feat/plugin-rows`.

**HIGH 1 — an unreachable `plugins` save error.** `validateSettings` can
return `errors.plugins` (e.g. a hand-edited `desktop.json` with a duplicate
spec — `config.ts` validates shape but never dedupes), but `plugins` had no
`#error-plugins` node and no `FIELD_TAB` entry: no text, no dot, no tab
switch, and a blank `status` identical to a successful save. Fixed two ways:
`settings.html` gained `#error-plugins` in the Plugins panel and `FIELD_TAB`
now maps `plugins` to it; and `performSave` gained a general fallback — any
rejected key whose `error-${name}` node does not exist now lands on the
status line instead of vanishing, so a *future* unmapped field fails the same
way rather than silently.

**HIGH 2 — rendered rows diverging from what is saved, in both directions.**
(a) `performSave` never re-read on success, so a row installed by that save
kept showing "not installed yet". Fixed: a successful save now calls
`load()`, safe specifically because nothing is pending at that point — the
read reflects exactly what was just submitted. The success status message is
reasserted after the reload (via a small `showSavedStatus` helper used both
before and after) so `load()`'s own error path can never leave a successful
save looking like "could not be read". (b) `acceptPluginUpdate` called
`load()` unconditionally, replacing `pluginRows` wholesale from disk and
silently discarding any row added or removed this session but not yet saved.
Fixed: it now updates only the one accepted row's `version` in place and
re-renders — no reload, since accepting one update never changes anything
else.

**MEDIUM 3 — double-Add race.** Guarded with a module-level `addingPlugin`
flag, set synchronously before the first `await`, so a second click landing
before the first's `validatePlugin` round-trip resolves returns immediately
instead of racing on a stale `existingPackages` snapshot. The Add button is
also disabled for the duration, mirroring Save's pattern.

**MEDIUM 4 — a save discarding every pending plugin update.**
`hideUpdateHint()` cleared the whole `pluginUpdates` map unconditionally, so
saving something unrelated (the hotkey) dropped every offered update before
`onPluginUpdateAvailable` (pushed once per `read`) could ever re-offer it.
Fixed: `hideUpdateHint()` now only hides the harness-source version hint;
per-plugin hints are reconciled solely by `load()`'s existing per-package
"drop it if this read shows it already applied" logic, which already ran on
every reload and is the correct place for it.

**LOW 5 — README.** Updated the Settings intro to mention the four tabs, and
rewrote the Plugins section for the row-based Add/Remove UI (it still
described "one package per line" and "Removing a line"). Also corrected the
stale `npm test` unit-test count.

**LOW 6 — two test weaknesses.** `pressTabKey` computed `prevented` but
discarded it with `void prevented`; it now returns the flag, and the arrow/
Home/End tests assert it, plus a new test confirms an unrelated key neither
moves the tab nor calls `preventDefault`. The "rows survive a reload from
config" test never actually triggered a `read()` before this round (nothing
called `load()` after save), so it only proved a re-render kept rows, not a
reload; now that a real reload happens (see HIGH 2a), the test asserts
`settings.read`'s call count actually grew, so it proves what its name says.

### New tests

Added to `src/renderer/settings.spec.ts`: an unmapped-error-key fallback
test; a `plugins`-error routes to the Plugins tab/node/dot test; a row
reflecting its resolved version after a successful save; an unsaved row
surviving an accepted update elsewhere (plus a `readCallCount` assertion that
the accept path never reloads); a double-Add-click guard test; and an
unrelated-save-keeps-plugin-update-hints test.

### Non-vacuity

**HIGH 1**: reverted the unmapped-error fallback (the `else unmapped.push(...)`
branch and its status-line write) in `performSave`. Ran
`npx vitest run src/renderer/settings.spec.ts -t "no error node of its own"`:
failed — `expected '' to contain 'Something about mysteryField is wrong.'`.
Restored; full suite green again.

**HIGH 2**: reverted `acceptPluginUpdate`'s in-place row update back to an
unconditional `await load()`. Ran
`npx vitest run src/renderer/settings.spec.ts -t "never re-reads config"`:
failed — `expected 2 to be 1` (the read count grew, proving the reload path
was back and the unsaved row's fate was no longer guaranteed). Restored; full
suite green again.

### Verification

- `npm run build` — clean.
- `npx vitest run` — 318 passed (was 310; +8 tests from this round).
- `npm run pack && npm run test:smoke` — packaged and the smoke test passed
  genuinely, with `~/.dsh` absent throughout.
- `grep -rn "/Users/" src/ tests/` — empty.
- `git -C ~/Development/deepseek-harness status --porcelain` —
  empty throughout.

## Review follow-up 2: the reload was still not actually safe

One finding left after the previous round. `performSave`'s `await load()` on
success was justified with "safe here specifically because nothing is
pending" — but nothing enforced that. Only the Save button was disabled
during a save; Add, each row's Remove, and each row's "Use it" stayed live.
A save can run for minutes (a cold managed install), so clicking Add or
Remove mid-save was likely, not exotic — and the reload would silently drop
an in-flight Add or resurrect a row an in-flight Remove had just taken out:
the exact bug this whole line of work set out to close, relocated from
`acceptPluginUpdate` into `performSave`.

**Fix:** a module-level `saveInFlight` flag, set at the start of
`performSave` (before its `await window.settings.save(...)`) and cleared in
its `finally`, however the save ends — success, a rejected field, or a
thrown error. `addPlugin`, `removePlugin`, and `acceptPluginUpdate` all
refuse outright while it is true, the same way a second `performSave` call
already refused itself only through the Save button's own `disabled`. Each
row's Remove and "Use it" buttons are rendered `disabled` for the same
duration (`renderPluginRows` now reads `saveInFlight`), and the Add button's
disabled state is centralized in `refreshAddDisabled()` so it correctly
reflects *either* reason it can be disabled (`addingPlugin` or
`saveInFlight`) rather than one clobbering the other.

### The resolved-version question

Reviewer also flagged: `acceptPluginUpdate` set the row's version to the
*requested* string, but main resolves and persists a concrete version that
the old `SaveResult` type never returned — the prior reload path incidentally
read disk truth for this; the in-place update traded that away without
replacing it.

**Chose: return the resolved version.** Rather than document an assumption
that the requested and resolved strings always match (true in every path
today, since the offer pushed to the renderer is already a concrete version,
not a dist-tag — but coupled across three files with nothing enforcing it),
`acceptPluginUpdate`'s success result now carries the concrete `version`
`installPlugin` actually resolved and wrote. Added `AcceptPluginUpdateResult`
(distinct from `SaveResult`, which `save` still uses unchanged) in
`settings-ipc.ts`; `performAcceptPluginUpdate` returns `{ ok: true, warnings,
version: concrete }`; the renderer sets the row from `result.version`, never
from the `version` it sent. A new `settings-ipc.spec.ts` test drives
`installPlugin` to resolve a *different* version than requested and asserts
the result and the written config both carry the resolved one, not the
requested one — proving this isn't just a passthrough that happens to work
when they coincide.

### New tests

Two in `settings.spec.ts`, under `plugins > gated while a save is in flight`:
an Add attempted mid-save is refused (Add button disabled, no
`validatePlugin` call, no row) and works normally once the save finishes; a
Remove attempted mid-save is refused (row count unchanged) and the row is
still there — not because the reload happened to keep it, but because Remove
was never allowed to touch it. One in `settings-ipc.spec.ts` for the
resolved-vs-requested version, described above.

### Non-vacuity

Reverted the gating: removed the `saveInFlight = true` block `performSave`
sets before its own save call (leaving the guards in `addPlugin` /
`removePlugin` intact but permanently unarmed, since the flag they check
never becomes true). Ran
`npx vitest run src/renderer/settings.spec.ts -t "mid-save"`: both new tests
failed — the Add test on `expected false to be true` (the Add button was not
disabled), the Remove test on `expected [...] to have a length of 2 but got
1` (the row was actually removed). Restored; full suite green again.

### Verification

- `npm run build` — clean.
- `npx vitest run` — 321 passed (was 318; +3: two gating tests, one
  resolved-version test).
- `npm run pack && npm run test:smoke` — packaged and the smoke test passed
  genuinely, with `~/.dsh` absent throughout.
- `grep -rn "/Users/" src/ tests/` — empty.
- `git -C ~/Development/deepseek-harness status --porcelain` —
  empty throughout.
