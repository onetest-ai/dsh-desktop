/**
 * The markdown document model — frontmatter, a lead, and `##` sections — replacing the YAML
 * managed-block entity files with something readable in a plain editor. This module is pure: it
 * knows nothing about entity fields or levels, only how to split a document apart and put it back
 * together byte for byte. `entity-schema.ts` (or whatever succeeds it) is the layer that maps
 * `EntityFields` onto sections; keeping that mapping out of here is what lets this module be tested,
 * and reasoned about, without dragging the whole schema in.
 *
 * The invariant the module owes its callers is that a document survives being written: for any
 * `EntityDoc` `joinDoc` can produce, `splitDoc(joinDoc(doc))` is that same document, field for
 * field. A section body is opaque markdown by the format's own claim, and it was not opaque to
 * `splitDoc` — a `##` inside one became a section of its own, a fence nobody closed swallowed every
 * heading below it, and a body's leading indentation was trimmed away. `normalizeBody` states the
 * rule that closes all three, and argues for it.
 *
 * Every rule in here is a rule about a line, which is why `toLf` runs before any of them: a file
 * whose lines end `\r\n`, or in a bare `\r`, failed the very first one and lost its frontmatter
 * altogether. The document's line ending is `\n`, and reading a file converts it — the argument is
 * on `toLf`.
 */
import { load as yamlLoad, dump as yamlDump, JSON_SCHEMA } from 'js-yaml'

/**
 * A document split into its three parts, in file order.
 *
 * `front` is untyped because this module does not know what an entity is — a
 * caller that does knows which keys to expect and defaults the rest.
 */
export interface EntityDoc {
  front: Record<string, unknown>
  lead: string
  sections: { heading: string; body: string }[]
}

/** A line that opens a fenced code block: three or more backticks or tildes, with or without an info string. */
const FENCE_OPEN = /^(`{3,}|~{3,})/
/** A line that closes one: the same character, at least as many of it, and nothing but space after. */
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/
/**
 * A `##` heading line — exactly two hashes, so `###` and deeper stay inside the section they sit in,
 * and at least one non-space character of text, so a heading always has something to be called.
 *
 * The `\S` is the whole of the second requirement and it is not cosmetic. With a
 * plain `.+?` capture, `##` followed by two spaces and a tab matched, trimmed to
 * a heading of `''`, and `joinDoc` wrote back a bare `## ` — which this pattern
 * does not match. That is the round-trip invariant broken literally: the block's
 * prose came back attached to whatever heading stood above it, and a `## `
 * re-emitted after the owned sections silently handed it to the next field
 * instead. A line that names no section is not a section; it stays prose, where
 * it round-trips as the bytes it is.
 */
const HEADING_LINE = /^##\s+(\S.*?)\s*$/
/** A line carrying nothing, for trimming a body's edges without touching its columns. */
const BLANK_LINE = /^\s*$/
/** A line ending that is not `\n` — `\r\n` or a bare `\r`. See `toLf`. */
const FOREIGN_EOL = /\r\n?/g

/**
 * The same text with every foreign line ending replaced by the one this module counts in.
 *
 * Every rule here is a rule about a line: the frontmatter fence, its terminator,
 * a `##` heading, a fence marker, a blank edge. All of them were written against
 * `\n`, and a file saved with `\r\n` failed the very first of them — `splitDoc`
 * gated the frontmatter on `startsWith('---\n')`, so a CRLF file had no
 * frontmatter at all and its keys became prose on the next write. A Windows
 * checkout, `core.autocrlf=true` or a `.gitattributes` saying `* text eol=crlf`
 * is enough to produce that, and this app ships on all three platforms.
 *
 * **A CRLF file is normalized to LF rather than kept as it was found**, and the
 * reason is that keeping it is not actually available. `joinDoc` writes the
 * frontmatter fence itself and gets the frontmatter body from `yamlDump`, both
 * of which are unconditionally LF; a document that preserved CRLF in its bodies
 * would be written back with mixed endings, which is worse than either. The
 * alternative — teaching every emitter the file's dialect — buys a byte back and
 * costs a per-document mode that every future rule would have to remember. So
 * the format's line ending is LF, one write converts a file to it, and the
 * conversion is visible in a diff exactly once. The cost is stated: a file a
 * Windows tool wrote comes back with different bytes than it went in with, the
 * same way its `##` inside a body comes back demoted.
 *
 * **A bare `\r` is a line ending too**, which is the `?` in the pattern and the
 * one place this rule went further than CRLF. The narrower `/\r\n/g` left two
 * holes, both real. A classic-Mac file — `---\rname: Q3\r---\r` — failed the
 * frontmatter gate exactly as a CRLF file used to, and one write re-emitted its
 * keys as prose: the format is dead, but the file is on disk and the damage is
 * total, and one character of pattern is a cheaper answer than a paragraph
 * explaining why it was left to happen. And a `\r` merely *ending* a line was
 * not left alone as the narrower rule's comment claimed: `joinDoc` appends the
 * body's own `\n` after it, making a `\r\n` for the next read to eat, so a
 * settled document changed on being written — the invariant broken over one
 * byte.
 *
 * What that costs is a lone `\r` in the **middle** of a line, which is now split
 * into two lines rather than carried through. That is the right reading twice
 * over: CommonMark, which governs what a body means, counts a bare `\r` as a
 * line ending, so a renderer was going to break the line whatever this module
 * did; and in every file that actually contains one, it *is* the line ending.
 * Preserving it would mean preserving it in the one case where doing so hides a
 * frontmatter — which is how the CR-only file loses everything.
 * @param text - text as it was found on disk, or as a caller holds it.
 * @returns the same text with `\r\n` and `\r` as `\n`.
 */
function toLf(text: string): string {
  return text.includes('\r') ? text.replace(FOREIGN_EOL, '\n') : text
}

/**
 * Which lines sit inside a fenced code block, and whether a fence was left open.
 *
 * Not a toggle over every line that starts with a fence character, which is what
 * this was: a ```` ```` ```` block around a ``` example desynchronises a toggle,
 * and so does a `~~~` line inside a backtick block. A fence is matched the way
 * CommonMark matches one — the closer is the same character, at least as long,
 * and carries no info string — so the two nest without lying to each other.
 *
 * An opener with no closer anywhere after it is **not a fence**: it is an
 * ordinary line, and scanning continues past it. That is the whole of finding 2.
 * A toggle would have made one stray ``` swallow every heading below it, which
 * `dumpEntity` then re-emits after the swallowed body, for the next read to
 * swallow again — the file gaining a heading set per write, forever.
 *
 * **Answered in one backward pass, not by searching forward from each opener.**
 * The obvious spelling — for each opener, scan on until a closer matches — is
 * O(lines × openers), and while a realistic file never notices (a 297 KB body
 * with a fence every ten lines splits in under two milliseconds), a file of ten
 * thousand unmatched fence-ish lines cost three quarters of a second per
 * `splitDoc`, once per entity on every `readBoard`. Walking the lines backward
 * and remembering, per marker character and per length, the nearest closer seen
 * so far answers the same question — the *first* closer after `i` that is the
 * same character and at least as long — in constant time per opener. Resolving a
 * line before recording it as a closer is what keeps that "after `i`": a fence
 * line is both, and a ``` cannot close itself.
 * @param lines - the body, already split on newlines.
 * @returns a flag per line, and the marker of the first fence nobody closed.
 */
function scanFences(lines: string[]): { fenced: boolean[]; unclosed: string | null } {
  const fenced = new Array<boolean>(lines.length).fill(false)
  // The nearest closer at or below each length, one array per marker character.
  // Sized by the longest run of that character anywhere, because an opener
  // longer than every closer in the file can only be unclosed.
  const longest = { '`': 0, '~': 0 }
  const trimmed = lines.map((l) => l.trim())
  const markers = trimmed.map((l) => l.match(FENCE_OPEN)?.[1] ?? '')
  for (const marker of markers) {
    if (marker) longest[marker[0] as '`' | '~'] = Math.max(longest[marker[0] as '`' | '~'], marker.length)
  }
  const nearest = {
    '`': new Int32Array(longest['`'] + 1).fill(-1),
    '~': new Int32Array(longest['~'] + 1).fill(-1),
  }
  const closeAt = new Int32Array(lines.length).fill(-1)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const marker = markers[i]
    if (!marker) continue
    const char = marker[0] as '`' | '~'
    if (marker.length <= longest[char]) closeAt[i] = nearest[char][marker.length]
    if (!FENCE_CLOSE.test(trimmed[i])) continue
    // A closer of length M answers every opener of length M or less, and the
    // one being recorded now is nearer than whatever was recorded before it.
    for (let len = 3; len <= marker.length; len += 1) nearest[char][len] = i
  }
  let unclosed: string | null = null
  for (let i = 0; i < lines.length; i += 1) {
    if (!markers[i]) continue
    const close = closeAt[i]
    if (close === -1) {
      if (unclosed === null) unclosed = markers[i]
      continue
    }
    for (let k = i; k <= close; k += 1) fenced[k] = true
    i = close
  }
  return { fenced, unclosed }
}

/** A body's lines with its blank edges dropped — blank lines, never columns. */
function stripBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && BLANK_LINE.test(lines[start])) start += 1
  while (end > start && BLANK_LINE.test(lines[end - 1])) end -= 1
  return lines.slice(start, end)
}

/**
 * Settle one body into the form the document can hold, so that writing it and reading it back
 * answers the same body.
 *
 * **The format's rule, decided here.** A section body is opaque markdown, and a
 * top-level `##` inside one is genuinely a new section in markdown: a format
 * cannot both split on `##` and let a body contain one. Of the two honest ways
 * out — the writer changing the line, or the reader splitting only on headings
 * it already knows — the writer wins, for two reasons. The reader that splits
 * only on known headings would have to be told the schema, which is exactly what
 * this module is defined by not knowing; and it would swallow the `## Rollout`
 * nobody modelled into whatever section stands above it, destroying the
 * unmodelled-section passthrough the store spec promises in the same breath.
 *
 * So: a `## Design` a writer put inside a body is written as `### Design`. It
 * stays a heading, it stays where it was written, it renders as what it meant,
 * and it nests under the section it actually sits in — which is what the writer
 * would have typed had they known the enclosing heading was already a `##`. One
 * hash is added; nothing is escaped, and nothing is removed.
 *
 * Three smaller rules fall out of the same requirement:
 *
 * - A fence nobody closed is closed, once, at the end of the body it opened in.
 *   `scanFences` refuses to treat it as a fence while it is open, so it swallows
 *   nothing; closing it here is what keeps a body self-contained, which is what
 *   makes it safe for `dumpEntity` to reorder sections. Without that, a body
 *   ending in a stray ``` could pair with a ``` in a body written after it.
 * - Blank edges are dropped; **columns are not**. A four-space-indented code
 *   block is opaque markdown too, and `trim()` ate its first line's indentation
 *   while leaving the rest — turning a code block into a paragraph and a stray
 *   indented line.
 * - A body of nothing but whitespace is nothing, because a heading with only
 *   blank lines under it round-trips as a heading with nothing under it.
 *
 * The function is idempotent, which is the property that matters: a settled body
 * settles to itself, so a file stops changing after the write that settles it.
 * @param text - the body as the caller holds it.
 * @returns the body as the document will hold it.
 */
export function normalizeBody(text: string): string {
  let lines = stripBlankEdges(toLf(text).split('\n'))
  const first = scanFences(lines)
  // Closed before anything is demoted, so a heading that turns out to sit inside
  // the reopened block is left exactly as its writer typed it.
  if (first.unclosed !== null) lines = [...lines, first.unclosed]
  const { fenced } = scanFences(lines)
  return lines.map((line, i) => (!fenced[i] && HEADING_LINE.test(line) ? `#${line}` : line)).join('\n')
}

/**
 * Split raw file text into frontmatter, a lead, and its sections.
 *
 * The frontmatter fence is optional rather than required: a file a person
 * started typing by hand, with no `---` yet, is still a document and must
 * still parse rather than throw. Section boundaries are found by scanning
 * lines rather than one big regex, because the fence-tracking a code block
 * needs (a `##` a person pasted as an example must not split the document)
 * is inherently stateful.
 *
 * This is the reading half of the invariant `normalizeBody` states: for any
 * document `joinDoc` can produce, `splitDoc(joinDoc(doc))` is `doc`. It splits
 * on exactly the lines `normalizeBody` demotes, and skips exactly the fenced
 * regions `normalizeBody` leaves alone, because both ask `scanFences`.
 * @param text - the full file contents.
 * @returns the parsed document.
 */
export function splitDoc(raw: string): EntityDoc {
  // Normalized once, here, rather than at each of the five places below that
  // ask a question about a line. A `\r` left on a body reaches the panel and the
  // agent as part of a field's value — `target` read back as `"ship it\r"` — and
  // a `\r` left on the frontmatter fence hid the frontmatter entirely.
  const text = toLf(raw)
  let front: Record<string, unknown> = {}
  let body = text
  if (text.startsWith('---\n')) {
    // The closing fence is a line that is exactly `---`, either found as
    // `\n---\n` partway through the text or as the text's own ending.
    const closeIdx = text.indexOf('\n---\n', 3)
    let yamlEnd = -1
    let bodyStart = -1
    if (closeIdx !== -1) {
      yamlEnd = closeIdx + 1
      bodyStart = closeIdx + 5
    } else if (text === '---\n' || text.endsWith('\n---\n')) {
      yamlEnd = text.length - 4
      bodyStart = text.length
    }
    if (yamlEnd !== -1) {
      const yamlText = text.slice(4, yamlEnd)
      const parsed = yamlLoad(yamlText, { schema: JSON_SCHEMA })
      front = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
      body = text.slice(bodyStart)
    }
  }
  const lines = body.split('\n')
  // One scan over the whole body rather than a flag carried line by line, so a
  // fence that is never closed cannot swallow the headings below it.
  const { fenced } = scanFences(lines)
  const sections: { heading: string; body: string }[] = []
  let current: { heading: string; lines: string[] } | null = null
  const leadLines: string[] = []
  const settle = (own: string[]): string => stripBlankEdges(own).join('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const headingMatch = !fenced[i] ? line.match(HEADING_LINE) : null
    if (headingMatch) {
      if (current) sections.push({ heading: current.heading, body: settle(current.lines) })
      current = { heading: headingMatch[1].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else leadLines.push(line)
  }
  if (current) sections.push({ heading: current.heading, body: settle(current.lines) })
  return { front, lead: settle(leadLines), sections }
}

/**
 * A heading as the document can hold it: what `splitDoc` would read back off the line it is written
 * on.
 *
 * `splitDoc` captures `(\S.*?)` and trims, so a heading it produces never has edge whitespace and
 * never has a line ending in it. A heading handed in by any other caller can have both, and each
 * broke the round trip in its own way: `## Notes ` came back as `Notes`, and `## a\rb` — now two
 * lines — came back as no heading at all, taking its section's body with it into the one above.
 * Neither is reachable through this module's own reader today, which is the reason to spend six
 * lines rather than six paragraphs on it: unreachable is a fact about today's callers, and the
 * invariant is stated over documents.
 *
 * Settled the way a body is, and for the same reason — the writer gives way, and no word is lost. A
 * line ending inside a heading becomes the space it already reads as, rather than truncating there,
 * because a heading is one line by construction and the text after the break is still the section's
 * name. Idempotent, so a file stops changing after the write that settles it.
 * @param heading - the heading as the caller holds it.
 * @returns the heading as the line will hold it.
 */
function settleHeading(heading: string): string {
  return toLf(heading).split('\n').join(' ').trim()
}

/**
 * Serialize a document back to file text.
 *
 * The frontmatter fence is always emitted, even for an empty `front`, so a
 * document is always recognizable as one and a reader never has to guess
 * whether the fence is missing or the frontmatter is just empty. A section
 * with a blank body still emits its heading — the levels a caller writes
 * into are fixed by the schema, and a blank one must stay visible to fill in
 * rather than vanish on the first round-trip.
 *
 * Every body — the lead included — goes through `normalizeBody` on the way out,
 * and every heading through `settleHeading`, which is where the format's rules
 * about what a body and a heading may contain are applied and argued. Doing it
 * here rather than at each call site is what makes them unavoidable: nothing
 * reaches disk except through this function.
 * @param doc - the document.
 * @returns the file text.
 */
export function joinDoc(doc: EntityDoc): string {
  let out = '---\n' + yamlDump(doc.front, { lineWidth: -1, noRefs: true }) + '---\n'
  const lead = normalizeBody(doc.lead)
  if (lead) out += '\n' + lead + '\n'
  for (const section of doc.sections) {
    const body = normalizeBody(section.body)
    const heading = settleHeading(section.heading)
    out += body ? '\n## ' + heading + '\n\n' + body + '\n' : '\n## ' + heading + '\n'
  }
  return out
}

/**
 * Find one section's body by heading.
 *
 * Case- and whitespace-insensitive because the heading is typed by hand each
 * time a section is written, and a caller matching on it should not have to
 * also match the exact capitalization used that day.
 * @param doc - the document to search.
 * @param heading - the heading to find.
 * @returns the section's body, or `''` when the document has no such section.
 */
export function sectionOf(doc: EntityDoc, heading: string): string {
  const target = heading.trim().toLowerCase()
  const found = doc.sections.find((s) => s.heading.trim().toLowerCase() === target)
  return found ? found.body : ''
}

/**
 * Read a checklist body — one `- [ ]` / `- [x]` line per criterion — the way a person actually
 * types one: a bare bullet with no checkbox still counts, and an upper-case `X` still ticks it.
 *
 * Ported from octoshell's `checklist-field.tsx` parse, which this format is
 * meant to look like in a plain editor.
 * @param body - the section body holding the checklist lines.
 * @returns the criteria, in file order.
 */
export function parseChecklist(body: string): { text: string; done: boolean }[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const cb = line.match(/^[-*]?\s*\[([ xX])\]\s*(.*)$/)
      if (cb) return { done: (cb[1] ?? ' ').toLowerCase() === 'x', text: (cb[2] ?? '').trim() }
      const text = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim()
      return { done: false, text }
    })
}

/**
 * Serialize criteria back to checklist lines.
 *
 * A blank-text item is dropped rather than written as `- [ ] ` — an empty
 * line in a checklist is not a criterion anyone meant to keep, and
 * `parseChecklist` would just have to drop it again on the next read.
 * @param items - the criteria, in the order to write them.
 * @returns the checklist body, one line per item, joined by `\n`.
 */
export function dumpChecklist(items: { text: string; done: boolean }[]): string {
  return items
    .filter((i) => i.text.trim().length > 0)
    .map((i) => `- [${i.done ? 'x' : ' '}] ${i.text.trim()}`)
    .join('\n')
}
