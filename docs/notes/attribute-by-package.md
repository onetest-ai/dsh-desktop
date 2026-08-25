# Attribute a boot failure by what the overlay actually references

## Regression

`plugin-link-by-name.md` moved the overlay's insert `name` from a resolved
absolute entry path to the plugin's bare package specifier, but
`attributeBootFailure` (`runtime-files.ts`) kept matching `RuntimeFiles.ready`
entries against `entryPath` — the field the harness's own error text no
longer names once a plugin links by name. The harness's real wording is
`failed to apply loader entry <id> (<name>): …`, where `<name>` is now the
bare package specifier, not the path `attributeBootFailure` searched for.
Zero matches means "unattributable", whose fallback drops *every* configured
plugin and records the same reason against each — reproduced live: two
plugins configured, `@deepseek-ai/dsh-mcp-client` legitimately needing
config and `@onetest/dsh-deck` healthy, both Settings rows showed the
mcp-client's error and both were disabled.

`declared-bundle-patch.md` compounds this: a package's own declared bundle
patch (e.g. `@onetest/dsh-deck`'s `id: deck`) mounts under an id the
synthesized `insertId(package)` never produces, so nothing that re-derives
an expected id from the package name can recognize it either.

## Fix

`RuntimeFiles.ready` becomes `AttributionRow[]` — `{ package, id, name }` —
one entry per row actually written to the overlay, carrying the exact `id`
and `name` `patchOverlay` gave that row. `patchOverlay` now returns
`{ overlay, rows }` instead of a bare string: `rows` is built in the same
loop, from the same branch (declared-patch row vs synthesized row), that
decides what to write — so attribution can never diverge from what the
overlay actually contains, and a declared row's own id/name (`deck` /
`@onetest/dsh-deck`) is carried through unmodified rather than re-derived.

`attributeBootFailure(message, ready: AttributionRow[])`:

1. **Primary: match `(${row.name})`.** A row's `name` is unique by
   construction — a bare package specifier is globally unique, a fallback
   entry path is unique to its install directory, and a declared row's own
   `name` is the package specifier it mounts — so this alone resolves every
   case in practice: linked-by-name, path-fallback, and declared-patch rows
   all show their own `name` in parens.
2. **Fallback: match `entry ${row.id} `.** Used only when no row's `name`
   matched. Anchored to the literal `entry <id> ` phrase so it cannot match
   a substring elsewhere. This is the id `insertId` collapses non-alphanumerics
   into (`@a-b/c` and `@a/b-c` both flatten to `a-b-c`) — the collision a
   previous pass avoided by matching paths instead — so it is only trusted
   when it singles out exactly one row.

Either stage requires exactly one matching *package* (rows can repeat a
package for a multi-row declared patch); zero or more than one is
unattributable, same as before.

Kept unrelated to attribution: `error-summary.ts` gains
`summarizeConfigurationNeed(reason)`, called only for
`disabledKind === 'needs-configuration'` rows in `settings-ipc.ts`. It runs
`summarizeFailure`'s existing extraction, then drops everything up to and
including cordis's own `invalid config:` marker, keeping the expected shape
and what was supplied — the only part of that message a user can act on.
Falls back to the unmodified `summarizeFailure` result when no marker
survives extraction or nothing follows it, so an unfamiliar error shape
still gets a summary rather than an empty string.

**Config editor pre-fill: not implemented, deliberately.** The "expected
shape" text is cordis's own rendered validation-error grammar — nested
unions, optional fields, arrays, records — with no parser this app owns and
no stability guarantee across schema authors. A wrong guess would look
plausible and get saved unnoticed, which is worse than an empty editor; and
for a union type (stdio vs streamable-http, in the real case) there is no
single correct skeleton to prefill without picking a branch the user didn't
choose. The expected-shape text stays visible on the row for the user to
read and type from.

## Tests

`runtime-files.spec.ts`'s `attributeBootFailure` describe block: the user's
real reason verbatim (two configured plugins, only the mcp client named,
the other left with no reason); a path-referenced entry still attributes;
a declared-patch row's own id/name (`deck` / `@onetest/dsh-deck`) attributes
correctly; a message naming none, or genuinely naming more than one, is
unattributable; an id collision between two distinct packages (`@a-b/c` /
`@a/b-c` both sanitizing to `a-b-c`) never attributes off the id alone.

`error-summary.spec.ts` and `settings-ipc.spec.ts`: `summarizeConfigurationNeed`
drops the loader-entry preamble from both the current (bare-name) and an
older (path-referenced) real reason while keeping the expected shape; falls
back to the full summary when no marker is found or nothing follows it.

**Non-vacuity (both reverted, confirmed failing, then restored):**

1. Forcing `attributeBootFailure` to always return `undefined` failed 5
   tests, including the real-reason test asserting only the named plugin is
   attributed.
2. Reducing `summarizeConfigurationNeed` to `return summarizeFailure(reason)`
   failed 3 tests asserting the loader-entry preamble is dropped.

## Verification against the real setup

Isolated `DSH_HOME` (`mkdtemp`), matching the user's exact configuration:
`@deepseek-ai/dsh-mcp-client@0.0.1-rc.1` (latest, no config) and
`@onetest/dsh-deck@0.2.2` (no config), both installed and linked by name the
same way `index.ts`'s `attemptBoot` does, then booted with the real
`deepseek-harness` checkout (`pnpm dsh --profile web --patch <overlay>`,
`DSH_HOME` passed through to the child).

1. Both plugins inserted: the real harness process exited 1 with (verbatim,
   trimmed):
   ```
   failed to apply loader entry deepseek-ai-dsh-mcp-client (@deepseek-ai/dsh-mcp-client): invalid config:
     - expected { transport?: "stdio", serverName: string, command: string, … } | { transport?: "streamable-http", … } but got {}
   ```
   `attributeBootFailure` on this genuine (not copied-fixture) text returned
   `@deepseek-ai/dsh-mcp-client` — PASS.
2. Retried overlay with only `@onetest/dsh-deck`: the real harness printed
   its `dsh web: http://127.0.0.1:<port>` ready line — PASS.
3. `curl http://127.0.0.1:<port>/plugins/@onetest/dsh-deck/client.js`
   returned `200` with `window.__ModuleLoader__.load({ id: "@onetest/dsh-deck", …`
   — the deck's browser half is served — PASS.

## Look

`dist/renderer/settings.html` served locally with a stub `window.settings`
carrying the mcp-client's real reason (needs-configuration) and the healthy
deck, at 640×720, light and dark. The mcp-client row now reads "Needs
configuration: expected { transport?: "stdio", … } but got {}" — no loader
id, no path, no "failed to apply" — followed by "Open Config below", "Full
error", and "Config" expanders; the deck row shows no reason at all. Both
color schemes render the row's warning tint (amber border/background) and
text legibly. The message reads as actionable: it states the shape the
config must have and what was actually given, which is exactly what a user
needs to author the config.

## Not done

Config-editor pre-fill from the expected shape — see the "not implemented,
deliberately" note above.
