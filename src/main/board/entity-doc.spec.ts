import { describe, expect, it } from 'vitest'
import { dumpChecklist, joinDoc, parseChecklist, sectionOf, splitDoc } from './entity-doc'

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
