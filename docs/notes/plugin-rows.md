# Plugin rows

Replaced the Settings window's plugin `<textarea>` with a row-based list: one
input plus an Add control, each accepted plugin its own row showing package,
resolved version (or "not installed yet"), pinned state, and any offered
update, with its own Remove control.

## Validation

Validation happens on Add, in the main process, over a new narrow `invoke`
channel `settings:validate-plugin` (exposed to the renderer as
`window.settings.validatePlugin(spec, existingPackages)`). It reuses the
existing `parseSpec`/`validSpecShape` grammar and returns the parsed
`{ spec, package, pinned }` on success so the renderer never needs its own
copy of the spec grammar to render a row. No new push channel was added; this
is a fifth `invoke`-style call-in alongside `read`/`save`/`pickFolder`/
`acceptPluginUpdate`. `parsePluginsField` (used at Save) is unchanged and
still independently re-validates the accumulated list.

## Duplicates

A spec naming a package already in the list is rejected at Add with
`"<pkg> is already in the list."`, distinct from the pre-existing Save-time
message (`"<pkg> is listed more than once."`) which still guards the rare
path where a `desktop.json`-shaped value reaches `validateSettings` some
other way.

## Styling

Rows are styled from the same `--dsw-*`-mirrored tokens as the rest of the
window (`src/renderer/settings.css`), matching the grouped-card layout and
capsule button geometry. Each row is a flex row with `min-width: 0` on every
shrinking level (`.plugin-rows` grid track, `.plugin-row`,
`.plugin-row-main`) so a long scoped package name truncates with an ellipsis
instead of wrapping or overflowing; `.plugin-rows` scrolls internally past
~4 rows instead of growing the window's fixed 620x640 frame.

Rendered `dist/renderer/settings.html` locally (via an iframe wrapper sized
exactly 620x640, since `position: fixed` inside an iframe is relative to the
iframe's own viewport) with a stub `window.settings`, at the real window size
in both light and dark. Confirmed: long-name truncation with ellipsis,
correct capsule Add button geometry, the validation error rendering in the
window's existing error style, an inline per-row "Use it" update hint that
does not affect other rows, and readable text/borders/focus colors in both
color schemes matching the surrounding groups.

## Tests

`src/renderer/settings.spec.ts` and the `src/main/settings-*.spec.ts` files
cover: Add appending a row and clearing the input; a malformed spec showing
an error and adding nothing; a duplicate spec being rejected with its own
message; Remove removing exactly the row it names; rows surviving a reload
from config; and an update offered for one row not disturbing others.

Non-vacuity was proved by reverting each of the two behaviors named in the
task and confirming the corresponding test fails:
- Removing the `!result.ok` early return in `addPlugin` (so a rejected spec
  is pushed as a row anyway) failed "shows an error next to the input and
  adds nothing on a malformed spec" — an unexpected row was rendered.
- Changing `removePlugin` to clear all rows (`pluginRows = []`) instead of
  filtering by package failed "removes exactly that entry, leaving the rest
  untouched" — the surviving row was gone too.
Both reverts were then restored and the full suite re-run clean.
