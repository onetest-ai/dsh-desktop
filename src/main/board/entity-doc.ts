/**
 * The markdown document model — frontmatter, a lead, and `##` sections — replacing the YAML
 * managed-block entity files with something readable in a plain editor. This module is pure: it
 * knows nothing about entity fields or levels, only how to split a document apart and put it back
 * together byte for byte. `entity-schema.ts` (or whatever succeeds it) is the layer that maps
 * `EntityFields` onto sections; keeping that mapping out of here is what lets this module be tested,
 * and reasoned about, without dragging the whole schema in.
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

/** A line that opens or closes a fenced code block, so a `##` inside one is never read as a heading. */
const FENCE_LINE = /^(```|~~~)/
/** A `##` heading line — exactly two hashes, so `###` and deeper stay inside the section they sit in. */
const HEADING_LINE = /^##\s+(.+?)\s*$/

/**
 * Split raw file text into frontmatter, a lead, and its sections.
 *
 * The frontmatter fence is optional rather than required: a file a person
 * started typing by hand, with no `---` yet, is still a document and must
 * still parse rather than throw. Section boundaries are found by scanning
 * lines rather than one big regex, because the fence-tracking a code block
 * needs (a `##` a person pasted as an example must not split the document)
 * is inherently stateful.
 * @param text - the full file contents.
 * @returns the parsed document.
 */
export function splitDoc(text: string): EntityDoc {
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
  let lead = ''
  const sections: { heading: string; body: string }[] = []
  let current: { heading: string; lines: string[] } | null = null
  let leadLines: string[] = []
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (FENCE_LINE.test(trimmed)) inFence = !inFence
    const headingMatch = !inFence ? line.match(HEADING_LINE) : null
    if (headingMatch) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').trim() })
      current = { heading: headingMatch[1].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else leadLines.push(line)
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').trim() })
  lead = leadLines.join('\n').trim()
  return { front, lead, sections }
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
 * @param doc - the document.
 * @returns the file text.
 */
export function joinDoc(doc: EntityDoc): string {
  let out = '---\n' + yamlDump(doc.front, { lineWidth: -1, noRefs: true }) + '---\n'
  if (doc.lead) out += '\n' + doc.lead + '\n'
  for (const section of doc.sections) {
    out += section.body ? '\n## ' + section.heading + '\n\n' + section.body + '\n' : '\n## ' + section.heading + '\n'
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
