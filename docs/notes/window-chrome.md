# Window chrome fixes: drag region, install progress, workspace-folder info

Three user-reported fixes on `fix/window-chrome`.

## 1. Main window drag region

The main window loads the harness Web UI unmodified with no preload, so
there is no markup lever available. `src/main/window.ts` now injects CSS
into `webContents` on every `dom-ready` (`DRAG_REGION_CSS`, exported for
testing):

- `body::before`, `position: fixed`, full width, **6px** tall, top of the
  window, `-webkit-app-region: drag`. 6px was chosen after inspecting the
  harness's own top-left content: the sidebar's logo/collapse button sits at
  6px of padding from the window's top edge in its expanded state (see
  `packages/client/ui-sidebar/src/client/SidebarRoot.module.css` in the
  harness repo, read-only), so a taller strip would sit under that button.
- A global `no-drag` rule on `button, a, input, textarea, select,
  [role="button"], [contenteditable]` as a second line of defense if a
  future harness layout narrows that 6px margin.

Re-injected on every `dom-ready` (harness URL and the error page from
`showError`) since a fresh document has no memory of a prior `insertCSS`
call.

**Settings window**: made genuinely frameless (`titleBarStyle: 'hidden'`,
`trafficLightPosition: { x: 16, y: 14 }`), because this window owns its
markup — no CSS-injection workaround needed. A real `.titlebar` element
(`position: fixed`, 38px tall) was added to `settings.html`/`.css`; `body`'s
top padding grew from 28px to 66px to keep the same 28px of breathing room
below it. The user believed this window was already frameless; now it is.
`titleBarStyle`/`trafficLightPosition` are macOS-only — Electron ignores
both elsewhere, so Windows/Linux keep their native frame (already
draggable) unaffected. Traffic lights sit inside the titlebar strip, clear
of `<main>`'s content; closing the window is unaffected since the traffic
lights are native OS controls, just repositioned.

**Verification**: `src/main/window.spec.ts` proves the CSS is produced and
contains both the drag strip and the no-drag exclusions, and that
`insertCSS` is called on every `dom-ready`, via a faked `electron` module
(no real window).

For an end-to-end check, the packaged app was launched via Playwright's
Electron API (`_electron.launch`) against an isolated `DSH_HOME`/
`userData`, the same pattern `tests/smoke.spec.ts` uses. Reading
`getComputedStyle(document.body, '::before')` from the real loaded harness
page confirmed the injected CSS reaches it exactly as authored
(`app-region: drag`, `height: 6px`). A scripted drag was then attempted:
`page.mouse.move/down/move.../up` over the strip, reading
`BrowserWindow.getBounds()` before and after. **The window bounds did not
change.** This is consistent with a known limitation of CDP-injected
synthetic mouse input on macOS — window dragging via `-webkit-app-region`
is driven by AppKit's native `mouseDown:`/drag handling, which synthetic
`Input.dispatchMouseEvent` calls do not appear to trigger, independent of
whether the drag region itself is correctly configured. A genuine OS-level
mouse drag (e.g. via Quartz) was not attempted, since that would move the
user's actual system cursor while their own packaged app is running and
risk disrupting their session. So: the CSS injection into the live packaged
app is verified; the OS actually treating that region as draggable is not
verified by an automated check here.

## 2. Install progress visible regardless of active tab

`#progress` already lived in the fixed `.actions` bar at the bottom of
`settings.html` (a sibling of `<main>`, not nested in any
`<section class="panel">`) — the fixed action bar the task suggested,
already spanning the window and always on screen. No move was needed; a
regression test was added instead, since nothing previously proved the
placement:

`src/renderer/settings.spec.ts` adds a markup-level check
(`panelRanges()`, a small tag-depth walker over `<section>` tags) asserting
`#progress`'s byte offset falls outside every `panel-*` section's range.
**Non-vacuity**: temporarily moved `#progress` into `panel-advanced` in
`settings.html`, reran the test — it failed
(`expected true to be false`, i.e. `insidePanel` became `true`) — then
restored the file. The restored version keeps `#progress` in `.actions`.

Manually verified in-browser (`dist/renderer` served locally, stubbed
`window.settings`): switched to the Advanced tab, pushed several npm lines
plus a status of "Installing…", and the progress block and status stayed
visible below the tab content in both light and dark.

## 3. Workspace-folder info affordance

Added a native `<details class="field-info"><summary aria-label="…">i</summary><p>…</p></details>`
next to the "Workspace folder" label. No script needed: `<summary>` is
natively Tab-reachable and Enter/Space-toggleable, and its `aria-label` is
the accessible name a screen reader announces. `.field-info` in
`settings.css` is a reusable block (circular "i" toggle, positioned
explanation card matching the design tokens, visible focus ring via the
existing `summary:focus-visible` rule) — copy it next to any other label
that needs the same treatment; only the workspace field got it in this
change, per the instruction not to bulk-annotate.

`src/renderer/settings.spec.ts` asserts the `<details>` sits with the
workspace label, its `<summary aria-label>` mentions "workspace", it
carries no `tabindex="-1"`, and it has real explanation text.

## Look at it

Served `dist/renderer/settings.html` locally (Chrome-in-browser tool),
640×720, both color schemes:

- **Light, info closed**: "Workspace folder" with a small circular "i"
  after the label; rest of the Harness tab unchanged.
- **Light, info open**: a card below the label reading "The working
  directory the harness runs in for a managed install — the folder the
  agent reads and writes files in. Defaults to your home folder.", not
  clipped, readable against the surface token.
- **Dark**: same layout; the "i" affordance and popover card use the same
  tokens, so it reads as native to the window in dark mode.
- **Save in progress, Advanced tab active**: pushed a status line
  ("Installing…") and five streamed npm lines while the Advanced tab (not
  Harness) was selected — the status and the scrollable monospace progress
  block both stayed visible in the fixed bottom bar, next to the Save
  button.

## Commands run

- `npm run build` — passed.
- `npx vitest run` — 343 tests passed (339 pre-existing + 4 new: 2 in
  `window.spec.ts`, 2 in `settings.spec.ts`).
- `npm run pack && npm run test:smoke` — packaged app built, smoke test
  passed (launches, renders the harness UI, leaves no orphans).

## Safety

All manual/e2e verification (browser preview, packaged-app drag check,
smoke test) used an isolated `DSH_HOME` and Electron `userData` directory
under the OS temp dir, provisioned the same way `tests/smoke.spec.ts`
does. The user's `~/.dsh`, their running packaged app, and
`deepseek-harness` (read-only reconnaissance of the harness's top-level UI
markup only) were not touched.
