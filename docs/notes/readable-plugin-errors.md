# Summarizing a plugin's raw boot-failure text on its Settings row

## The situation

A disabled plugin's row showed the harness's raw `disabledReason` in full —
for `@deepseek-ai/dsh-mcp-client`, thousands of characters of a
three-level-deep `Error.cause` chain, the same message repeated once per
level, with the one actionable sentence (`invalid config: - expected {
serverName: string, … } but got {}`) buried in the middle. The plugin system
was working correctly (a legitimate "you must configure me" failure), but
the presentation read as a broken app.

## Fix — extract the signal, keep the raw text one click away

`src/main/error-summary.ts`'s `summarizeFailure(message): string` is a pure
heuristic over Node's `Error.cause` printing, not a parser for any one
plugin's failure shape:

1. Collapse whitespace, then strip — wherever they appear in the text, not
   only at line starts, since the harness's own text wraps mid-frame — every
   stack frame (`at <frame>(...)`, matched globally), the literal `... N
   lines matching cause stack trace ...` dedupe marker, and the `{ [cause]:
   ` wrapper Node's `cause` printing opens each nested error with.
2. Split what remains at `SomeError: ` class-name boundaries — each such
   boundary starts a new nested error's own message.
3. Segments that share a message (by `dedupeKey`: their first 24
   alphanumeric characters, lowercased — tolerant of an outer level's full
   detail vs. an inner level's abridged `{...}` repeat of the same message)
   collapse to whichever occurrence is longer, keeping the more detailed
   wording.
4. The longest surviving segment is the summary, bounded to
   `MAX_SUMMARY_LENGTH` (400 — long enough to hold a full `expected {...} but
   got {}` sentence, short enough to stay a glance).

An error this heuristic cannot make sense of — nothing left after stripping,
or no `SomeError:` boundary at all — falls through to `fallbackSummary`: a
bounded, single-line prefix of the raw text. Blank input never yields a
blank summary (`'The harness reported no further detail.'`).

`settings-ipc.ts`'s `read()` computes `PluginInfo.disabledSummary` from
`disabledReason` via `summarizeFailure`, alongside the existing full
`disabledReason` — both are sent to the renderer. `settings.js`'s
`renderPluginRows` shows `disabledSummary` (falling back to `disabledReason`
for a caller that never set it) in the existing `.plugin-disabled-note`
line, and adds a `<details class="plugin-disabled-detail">` — collapsed by
default, the same disclosure pattern the row's config editor already uses —
holding the full raw `disabledReason` in a scrollable, wrapped `<pre>`.

**The unresolvable-library case** (`@modelcontextprotocol/sdk`, which has no
cordis plugin entry point): `checkPackageLoadable`'s own message (`<pkg> is
not resolvable from <dir>: <cause>`) is already a single line with no stack
frames, so `summarizeFailure` passes it through unchanged (verified in the
test suite). No special-casing was added to say something more directional
("this looks like a library, not a plugin") — that would mean guessing plugin
intent from a resolver error text alone, indistinguishable from a typo'd
package name or a plugin that simply is not installed yet, without hardcoding
`@modelcontextprotocol/sdk` by name. Skipped as asked when it cannot be done
honestly and generally.

## Styling (`settings.css`)

`.plugin-disabled-detail` reuses `.plugin-config`'s disclosure triangle
pattern (`▸`/`▾` via `summary::before`, `list-style: none`, `::-webkit-
details-marker` hidden). `.plugin-disabled-full` is a bounded, scrollable
(`max-height: 240px`, `overflow-y: auto`), monospace, `overflow-wrap: anywhere`
box using the same `--input-fill`/`--border`/`--label-secondary` tokens as
the rest of the panel, so it reads as native to the window in both themes
without a dedicated new palette. The existing global `summary:focus-visible`
rule (shared with every other `<summary>` on the page) covers its focus
ring; no new selector was needed.

## Non-vacuity

Reverted `summarizeFailure` to `return message` (pass the raw text through
unchanged) and reran `error-summary.spec.ts`: 4 of 5 tests failed — the real
fixture's summary still contained `at Entry._init`/`file:///`/the dedupe
marker, the 50-frame fallback test returned 1929 characters instead of
≤400, and blank input returned `''`. Only the already-trivial single-line
resolver-message passthrough test still passed. Restored; all 5 green again.

## What I looked at

Served `dist/renderer/settings.html` with a stub `window.settings.read()`
carrying the real (redacted-path) `dsh-mcp-client` fixture, the healthy hooks
bridge, and an unresolvable `@modelcontextprotocol/sdk` entry, at 640×720 in
both color schemes:

- **Light, collapsed**: three plugin rows. The two disabled rows carry a
  danger-tinted border/background and a short one-line `Disabled — …` note
  ending in `but got {}` / `Cannot find module` — no stack trace, no
  `file:///`, no repeated sentence. A `▸ Full error` disclosure sits under
  each note, closed.
- **Light, expanded**: opening `▸ Full error` reveals the complete raw
  `disabledReason` in a bordered, monospace, internally scrollable box; the
  long unbroken module path wraps rather than overflowing the row or the
  window.
- **Dark, collapsed and expanded**: same layout; the danger border/tint and
  the monospace box both read correctly against the dark surface tokens —
  no light-mode-only color left unguarded.

Removed the stub script and its injected `<script>` tag from
`dist/renderer/settings.html` afterward and reran `npm run build`, which
overwrites `dist/renderer/*` from `src/renderer/*` — `dist` matches source
again.

## Verification

`npm run build`, `npx tsc -p tsconfig.json --noEmit`, and `npx vitest run`
all pass (410 tests, up from 403 — `error-summary.spec.ts` adds 5, plus one
new assertion each in `settings-ipc.spec.ts` and `settings.spec.ts`).
`pgrep -f "DeepSeek Harness.app/Contents/MacOS"` found the user's own app
running, so `npm run pack`/`npm run test:smoke` were skipped rather than
risking `app.asar` under a live process. `~/.dsh` was never read or written
by this change — the fix and its tests are pure string transforms over
already-collected `disabledReason` text.
