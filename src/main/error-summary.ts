/**
 * Turn the harness's own boot-failure text into a short, readable summary.
 *
 * A boot failure the harness reports carries a full stack trace, often
 * nested three levels deep through a `cause` chain that repeats the same
 * message at each level (Node prints `... N lines matching cause stack
 * trace ...` for the parts it dedupes itself, but the leading message text
 * of each `cause` frame still repeats, sometimes abridged, sometimes not).
 * The one sentence a user can act on — "invalid config: expected X but got
 * Y", "ENOENT", "not resolvable" — is buried in the middle. This module
 * extracts that sentence for display on a plugin's Settings row, while the
 * full text stays reachable behind an expander (see `settings.js`'s
 * `renderPluginRows`).
 */

/** A stack frame anywhere in the text, e.g. `at Entry._init (file:///…/index.js:299:9)`. */
const STACK_FRAME_GLOBAL = /\bat\s+(?:async\s+)?[\w$.<>]+\s*\([^()]*\)/g

/** The literal marker Node prints for a `cause` chain's deduped shared frames. */
const DEDUPE_MARKER_GLOBAL = /\.\.\.\s*\d+\s+lines?\s+matching\s+cause\s+stack\s+trace\s*\.\.\./gi

/** The `{ [cause]: ` wrapper Node's `cause`-chain printing opens each nested error with. */
const CAUSE_WRAPPER_GLOBAL = /\{\s*\[cause\]:\s*/g

/** Lookahead boundary at the start of a `SomeError: ` class-name prefix, e.g. `ValidationError: `. */
const ERROR_CLASS_BOUNDARY = /(?=\b\w*Error:\s)/

/**
 * Longest summary this module ever returns, including the fallback prefix.
 * Long enough to hold a full sentence like the `invalid config: … but got
 * {}` message; short enough that the row stays a glance, not a second wall
 * of text next to the one this function exists to replace.
 */
const MAX_SUMMARY_LENGTH = 400

/**
 * A dedup key for a message segment: its first 24 alphanumeric characters,
 * lowercased. Two segments sharing this key are treated as the same
 * underlying message repeated at different `cause` levels — which is
 * exactly what the leading words of a repeated message are, even when the
 * trailing detail differs (e.g. a full expected shape at the outer level,
 * abridged to `{...}` at an inner one).
 * @param segment - a candidate message segment.
 * @returns the dedup key, or `''` when the segment has no alphanumeric content.
 */
function dedupeKey(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24)
}

/**
 * Extract the meaningful sentence from a harness boot-failure message.
 *
 * The strategy: collapse whitespace, strip every stack frame and the
 * `cause`-chain dedupe marker wherever they appear (not only at line
 * starts — the harness's own text wraps mid-frame), strip the `{ [cause]:
 * ` wrapper Node's `cause` printing opens each nested error with, then
 * split what remains at `SomeError: ` class-name boundaries — each such
 * boundary starts a new nested error's own message. Segments that repeat
 * the same leading message (by `dedupeKey`) collapse to whichever
 * occurrence is longest — usually the more detailed one — and the longest
 * surviving segment overall is the summary.
 *
 * This is a heuristic over Node's `Error.cause` printing, not a parser for
 * any specific plugin's failure shape — an error this pass cannot make
 * sense of (nothing left after stripping, or no `SomeError:` boundary at
 * all) falls through to `fallbackSummary`'s bounded prefix rather than a
 * confident but wrong extraction.
 * @param message - the harness's own failure text, as surfaced by `disabledPlugins()`.
 * @returns a short, human-readable summary; never empty for non-blank input.
 */
export function summarizeFailure(message: string): string {
  const trimmed = message.trim()
  if (trimmed === '') return 'The harness reported no further detail.'

  const stripped = trimmed
    .replace(/\s+/g, ' ')
    .replace(DEDUPE_MARKER_GLOBAL, ' ')
    .replace(STACK_FRAME_GLOBAL, ' ')
    .replace(CAUSE_WRAPPER_GLOBAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (stripped === '') return fallbackSummary(trimmed)

  const segments = stripped
    .split(ERROR_CLASS_BOUNDARY)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  const best = new Map<string, string>()
  for (const segment of segments) {
    const key = dedupeKey(segment)
    if (key === '') continue
    const existing = best.get(key)
    if (existing === undefined || segment.length > existing.length) best.set(key, segment)
  }

  if (best.size === 0) return fallbackSummary(trimmed)

  const chosen = [...best.values()].reduce((a, b) => (b.length > a.length ? b : a))
  return bound(chosen)
}

/**
 * A bounded prefix of the raw text, used when `summarizeFailure` finds
 * nothing it recognizes as a message segment — e.g. an error shape this
 * module was never fit to. Never empty for non-blank input, so the
 * Settings row never shows a blank reason.
 * @param trimmed - the already-trimmed raw failure text.
 * @returns a bounded, single-line prefix of the raw text.
 */
function fallbackSummary(trimmed: string): string {
  return bound(trimmed.replace(/\s+/g, ' ').trim())
}

/**
 * Truncate to `MAX_SUMMARY_LENGTH`, marking truncation with an ellipsis.
 * @param text - the candidate summary text.
 * @returns `text` unchanged if short enough, otherwise a bounded prefix.
 */
function bound(text: string): string {
  return text.length <= MAX_SUMMARY_LENGTH ? text : `${text.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
}

/**
 * The literal prefix cordis's own `ValidationError` message always opens
 * with, whichever cause level it appears at (see vendor/cordis's `fiber.ts`
 * `ValidationError` constructor: `` `invalid config:\n` + issues... ``).
 * Matched case-insensitively since Node's `cause`-chain printing can wrap or
 * requote surrounding text but never this literal message content.
 */
const VALIDATION_ERROR_MARKER = /\binvalid config:/i

/**
 * Whether a plugin's `disabledReason` is a configuration-shape problem —
 * cordis rejecting the entry's stored `config` (absent or present) against
 * its own schema — rather than a genuine failure such as an unresolvable
 * module or a runtime throw during boot.
 *
 * Classified structurally, from the literal `invalid config:` prefix
 * cordis's `ValidationError` always opens its message with, never from the
 * plugin's package name and never from whether the stored config happens to
 * be empty: a plugin whose config is present but shaped wrong (a typo'd
 * field, a wrong type) raises the same error class as one with no config at
 * all, and both are equally a setup step, not a crash. A `disabledReason`
 * this check does not recognize is treated as a genuine failure — the
 * default a caller should use for presentation — since claiming "this just
 * needs configuring" for an unrelated crash would mislead the user worse
 * than the loud presentation it would replace.
 * @param reason - the raw `disabledReason` text (see `PluginInfo`).
 * @returns whether `reason` reads as a configuration-shape problem.
 */
export function isConfigurationProblem(reason: string): boolean {
  return VALIDATION_ERROR_MARKER.test(reason)
}

/**
 * The actionable half of a needs-configuration failure's summary: whatever
 * follows cordis's own `invalid config:` marker — the expected shape and
 * what was actually supplied — with the loader-entry preamble before it
 * dropped (`failed to apply loader entry <id> (<name>): `). That preamble
 * names the loader id and the package, already shown on the plugin's own
 * Settings row; it gives the user nothing to act on, unlike the schema that
 * follows, which is the only real guidance a needs-configuration error
 * carries.
 *
 * Falls back to `summarizeFailure`'s own extraction — never to the raw,
 * unbounded text — when the marker is not found in the summarized text, or
 * when everything after it is blank: an unfamiliar validation-error shape
 * (this function is not a parser for any one plugin's schema, only for
 * cordis's own fixed `invalid config:` wrapper) still gets a useful summary
 * rather than an empty one.
 * @param reason - the raw `disabledReason` text; the caller has already
 *   confirmed it is a configuration problem via `isConfigurationProblem`.
 * @returns a summary leading with the expected shape.
 */
export function summarizeConfigurationNeed(reason: string): string {
  const summarized = summarizeFailure(reason)
  const match = VALIDATION_ERROR_MARKER.exec(summarized)
  if (match === null) return summarized
  const after = summarized.slice(match.index + match[0].length).trim()
  return after === '' ? summarized : after
}
