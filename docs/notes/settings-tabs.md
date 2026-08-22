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
- `git -C /Users/arozumenko/Development/deepseek-harness status --porcelain` —
  empty throughout.
