# Needs-configuration state for plugin rows

## Problem

A plugin like `@deepseek-ai/dsh-mcp-client` that requires config (an stdio or
HTTP MCP server) has none yet, so cordis's own `ValidationError` rejects it
at boot. The Settings row showed this identically to a genuine failure: red
border, "Disabled — the harness would not start with it: …". That reads as
an alarm for what is actually an unfinished setup step.

## Classification

`isConfigurationProblem` (`src/main/error-summary.ts`) detects the literal
`invalid config:` prefix cordis's `ValidationError` constructor always opens
its message with (`vendor/cordis/src/fiber.ts` in `deepseek-harness`,
read-only reference — not part of this change). This is structural, not
name- or emptiness-based: a plugin with config present but shaped wrong
(bad field, wrong type) throws the same error class as one with no config
at all, and both are classified `needs-configuration`. Any `disabledReason`
that does not match falls back to `failed` — the existing loud
presentation — so an unrecognized crash is never mislabeled as "just needs
configuring".

`settings-ipc.ts`'s `read()` computes `disabledKind: 'needs-configuration' |
'failed' | undefined` per plugin from this check and sends it to the
renderer alongside the existing `disabledReason`/`disabledSummary`.

## Presentation

`settings.js` renders three states per row: healthy (`plugin-row`),
needs-configuration (`plugin-row-needs-config`, new `--setup` amber token,
"Needs configuration: …" note with an "Open Config below" button that
expands the row's existing Config editor and focuses its textarea), and
failed (`plugin-row-disabled`, unchanged `--danger` red, "Disabled — the
harness would not start with it: …"). Both keep the harness's own
expected-shape text (via `summarizeFailure`) inline, with the full raw error
one click away in the existing "Full error" expander.

Needs-configuration rows do **not** auto-open their Config editor, even when
there is only one: several open editors on load reads as a wall of forms,
not a calm list, and the note's own "Open Config below" control is one click
away regardless of row count. Auto-open stays driven only by
"does this row already have config set" (`hasConfig`), unchanged from
before.

`--setup` was added to `settings.css` beside `--danger`/`--ok`, with a light
and dark value, plus `:focus-visible` styling on the new "Open Config below"
button.

## Tests

- `src/main/error-summary.spec.ts`: `isConfigurationProblem` against the
  real `@deepseek-ai/dsh-mcp-client` fixture (`REAL_MCP_CLIENT_REASON`,
  already in this file) classifies as configuration; a module-resolution
  reason and an unfamiliar `TypeError` shape do not; `summarizeFailure`'s
  extracted text from that same fixture still contains the expected shape.
- `src/main/settings-ipc.spec.ts`: `read()` assigns `disabledKind:
  'needs-configuration'` for a config-validation reason, `'failed'` for a
  resolution reason, and `undefined` for a healthy entry.
- `src/renderer/settings.spec.ts`: a needs-configuration row shows "Needs
  configuration" (not "Disabled"/"would not start") and the
  `plugin-row-needs-config` class, alongside an unaffected failed row and
  healthy row.

### Non-vacuity

- Forced `isConfigurationProblem` to always return `false`: the "classifies
  the real dsh-mcp-client config-validation failure as a configuration
  problem" test failed (`expected false to be true`). Restored.
- Forced `isConfigurationProblem` to always return `true`: the "does not
  classify an unfamiliar error shape … falls back to the failure
  presentation" test failed (`expected true to be false`). Restored.

## Verification

- `npm run build` — clean.
- `npx vitest run` — 419 tests passed (413 baseline + 6 new).
- Rendered `dist/renderer/settings.html` with a stubbed `window.settings`
  carrying three rows (needs-configuration, failed, healthy) at 640×720 in
  light and dark. The needs-configuration row shows a subtle amber tint,
  amber note text, and an underlined "Open Config below" link; the failed
  row shows a stronger red tint and red text; the healthy row carries
  neither. The needs-configuration row reads calmer than the failed row at
  a glance in both schemes — same layout, different tone, no "would not
  start" language. Stub removed and renderer rebuilt afterward.
- Did not run `npm run pack`/`npm run test:smoke`: the user's own
  `DeepSeek Harness.app` was running (`pgrep` matched its PID) for the
  entire session, so packaging was skipped per the packaging-safety
  constraint.
