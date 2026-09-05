import { describe, expect, it } from 'vitest'
import { dumpChecklist, joinDoc, normalizeBody, parseChecklist, sectionOf, splitDoc } from './entity-doc'

describe('splitDoc', () => {
  it('reads the frontmatter, the lead, and each section in file order', () => {
    const doc = splitDoc('---\nname: Ship it\nstatus: executing\n---\n\nThe lead.\n\n## Notes\n\nA note.\n')
    expect(doc.front).toEqual({ name: 'Ship it', status: 'executing' })
    expect(doc.lead).toBe('The lead.')
    expect(doc.sections).toEqual([{ heading: 'Notes', body: 'A note.' }])
  })

  it('treats a file with no frontmatter fence as all body', () => {
    const doc = splitDoc('Just prose.\n')
    expect(doc.front).toEqual({})
    expect(doc.lead).toBe('Just prose.')
  })

  it('keeps a heading deeper than two hashes inside the section it sits in', () => {
    const doc = splitDoc('---\n---\n\n## Steps\n\n### First\n\nDo it.\n')
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].body).toBe('### First\n\nDo it.')
  })

  it('does not mistake a hash inside a fenced code block for a heading', () => {
    const doc = splitDoc('---\n---\n\n## Steps\n\n```\n## not a heading\n```\n')
    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0].body).toBe('```\n## not a heading\n```')
  })

  it('answers with an empty front when the frontmatter is an empty document', () => {
    expect(splitDoc('---\n---\nBody.\n').front).toEqual({})
  })

  it('keeps a timestamp a string rather than resolving it to a date', () => {
    const doc = splitDoc('---\nat: 2026-09-05T09:12:00Z\n---\n')
    expect(doc.front.at).toBe('2026-09-05T09:12:00Z')
  })
})

describe('joinDoc', () => {
  it('round-trips a document byte for byte', () => {
    const text = '---\nname: Ship it\n---\n\nThe lead.\n\n## Notes\n\nA note.\n'
    expect(joinDoc(splitDoc(text))).toBe(text)
  })

  it('omits the lead when there is none, and still emits the fence', () => {
    expect(joinDoc({ front: { name: 'x' }, lead: '', sections: [] })).toBe('---\nname: x\n---\n')
  })

  it('separates every section by exactly one blank line', () => {
    const out = joinDoc({ front: {}, lead: 'Lead.', sections: [{ heading: 'A', body: 'a' }, { heading: 'B', body: 'b' }] })
    expect(out).toBe('---\n{}\n---\n\nLead.\n\n## A\n\na\n\n## B\n\nb\n')
  })
})

describe('sectionOf', () => {
  it('matches a heading regardless of case and surrounding space', () => {
    const doc = splitDoc('---\n---\n\n##   Steps to Reproduce  \n\nDo it.\n')
    expect(sectionOf(doc, 'Steps to Reproduce')).toBe('Do it.')
  })

  it('answers with an empty string for a heading the document does not have', () => {
    expect(sectionOf(splitDoc('---\n---\n'), 'Notes')).toBe('')
  })
})

describe('parseChecklist', () => {
  it('reads a ticked and an unticked line', () => {
    expect(parseChecklist('- [ ] one\n- [x] two')).toEqual([
      { text: 'one', done: false },
      { text: 'two', done: true },
    ])
  })

  it('takes a bare bullet as an unticked criterion', () => {
    expect(parseChecklist('- three')).toEqual([{ text: 'three', done: false }])
  })

  it('accepts an upper-case tick, because a person typed it', () => {
    expect(parseChecklist('- [X] one')).toEqual([{ text: 'one', done: true }])
  })

  it('drops blank lines rather than making an empty criterion of each', () => {
    expect(parseChecklist('- [ ] one\n\n\n- [ ] two')).toHaveLength(2)
  })

  it('round-trips through dumpChecklist', () => {
    const items = [{ text: 'one', done: true }, { text: 'two', done: false }]
    expect(parseChecklist(dumpChecklist(items))).toEqual(items)
  })
})

/**
 * The bodies that break a naive split, each with what it must look like once the
 * document has been written once.
 *
 * A property over a set of adversarial bodies rather than six separate cases,
 * because the thing being pinned is one invariant — `splitDoc(joinDoc(doc))`
 * answers `doc` — and a case per symptom would pin the symptoms instead.
 */
const ADVERSARIAL: readonly (readonly [what: string, body: string, settled: string])[] = [
  ['a `## ` line at column zero', 'intro\n\n## Design\n\ndeep stuff', 'intro\n\n### Design\n\ndeep stuff'],
  ['a fence nobody closed', 'before\n```\nnever closed', 'before\n```\nnever closed\n```'],
  ['a tilde fence around a heading', '~~~\n## not a heading\n~~~', '~~~\n## not a heading\n~~~'],
  ['a four-space indented code block', '    const x = 1\n\n    return x', '    const x = 1\n\n    return x'],
  ['nothing but whitespace', '   \n\t\n  ', ''],
  ['a line that is three dashes', 'above\n---\nbelow', 'above\n---\nbelow'],
  ['a long fence holding a shorter one', '````\n```\n## inner\n```\n````', '````\n```\n## inner\n```\n````'],
]

describe('the round-trip invariant', () => {
  for (const [what, body, settled] of ADVERSARIAL) {
    it(`splits back to the document it was joined from, for a body holding ${what}`, () => {
      const text = joinDoc({
        front: { name: 'x' },
        lead: body,
        sections: [{ heading: 'A', body }, { heading: 'B', body: 'plain' }],
      })
      const doc = splitDoc(text)
      // The headings first: finding a body's own `##` as a third section, or
      // losing `B` into a fence that was never closed, is what this guards.
      expect(doc.sections.map((s) => s.heading)).toEqual(['A', 'B'])
      expect(doc.lead).toBe(settled)
      expect(doc.sections[0].body).toBe(settled)
      expect(doc.sections[1].body).toBe('plain')
      // The invariant itself, and the bytes: a second write changes nothing.
      expect(splitDoc(joinDoc(doc))).toEqual(doc)
      expect(joinDoc(doc)).toBe(text)
    })
  }
})

/**
 * A file saved with Windows line endings, which a cross-platform Electron app
 * gets for free from a Windows checkout, `core.autocrlf=true`, or a
 * `.gitattributes` saying `* text eol=crlf`.
 *
 * The gate on the frontmatter fence was `startsWith('---\n')`, which a `---\r\n`
 * file fails — so the whole file, frontmatter included, became the body, and the
 * next write re-emitted the entity's own keys as prose. Every line-oriented rule
 * in the module reads the same way, so each is asked here separately.
 */
describe('a document with CRLF line endings', () => {
  const CRLF = [
    '---',
    'name: Q3 Campaign',
    'subtype: campaign',
    'status: executing',
    '---',
    '',
    'the description',
    '',
    '## Target',
    '',
    'ship it',
    '',
    '## Notes',
    '',
    '```',
    '## not a heading',
    '```',
    '',
  ].join('\r\n')

  it('reads its frontmatter rather than taking the whole file as body', () => {
    const doc = splitDoc(CRLF)
    expect(doc.front).toEqual({ name: 'Q3 Campaign', subtype: 'campaign', status: 'executing' })
    expect(doc.lead).toBe('the description')
  })

  it('finds every heading, and leaves no carriage return on a body', () => {
    const doc = splitDoc(CRLF)
    expect(doc.sections.map((s) => s.heading)).toEqual(['Target', 'Notes'])
    expect(doc.sections[0].body).toBe('ship it')
    expect(CRLF).toContain('\r')
    expect(JSON.stringify(doc)).not.toContain('\\r')
  })

  it('still refuses to split on a heading inside a fence written with CRLF', () => {
    expect(splitDoc(CRLF).sections[1].body).toBe('```\n## not a heading\n```')
  })

  it('answers with an empty front for a CRLF file whose frontmatter is empty', () => {
    expect(splitDoc('---\r\n---\r\nBody.\r\n').front).toEqual({})
  })

  it('normalizes a CRLF body to the line endings the document writes', () => {
    expect(normalizeBody('a\r\n\r\n## Design\r\nb')).toBe('a\n\n### Design\nb')
  })

  it('is written back with LF throughout, and is byte-stable from then on', () => {
    const once = joinDoc(splitDoc(CRLF))
    expect(once).not.toContain('\r')
    expect(joinDoc(splitDoc(once))).toBe(once)
    expect(splitDoc(once)).toEqual(splitDoc(CRLF))
  })
})

/**
 * `## ` followed by nothing but whitespace. The heading pattern matched it and
 * trimmed the capture to `''`, and `joinDoc` then wrote `## `, which the same
 * pattern does not match — the literal counterexample to
 * `splitDoc(joinDoc(doc))` being `doc`, with the block's prose re-attributed to
 * whatever heading stood above it on the next read.
 */
describe('a heading whose text is only whitespace', () => {
  const HAND_EDITED = '---\nname: Q3\n---\n\nlead\n\n##  \t\nkept prose\n\n## Notes\n\nn\n'

  it('is not a heading, so nothing is split on it', () => {
    const doc = splitDoc(HAND_EDITED)
    expect(doc.sections.map((s) => s.heading)).toEqual(['Notes'])
    expect(doc.lead).toBe('lead\n\n##  \t\nkept prose')
  })

  it('round-trips, and the prose under it is not re-attributed', () => {
    const doc = splitDoc(HAND_EDITED)
    const written = joinDoc(doc)
    expect(splitDoc(written)).toEqual(doc)
    expect(joinDoc(splitDoc(written))).toBe(written)
    expect(splitDoc(written).sections[0].body).toBe('n')
  })
})
