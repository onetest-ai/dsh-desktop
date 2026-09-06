// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { statusGlyph, verdictDot } from './status-glyph.ts'

describe('statusGlyph', () => {
  it('returns an svg carrying the status as a data attribute, for each of the five', () => {
    for (const s of ['idea', 'backlog', 'executing', 'validation', 'done']) {
      const g = statusGlyph(s)
      expect(g.tagName.toLowerCase()).toBe('svg')
      expect(g.dataset.status).toBe(s)
      expect(g.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('marks an unknown status apart, so a finding does not draw as a real state', () => {
    expect(statusGlyph('weird').dataset.status).toBe('unknown')
  })

  it('fills done with the success token and executing with the accent token', () => {
    // the fill/stroke is set via a CSS custom prop or class the stylesheet keys on,
    // never a literal — assert the class the sheet targets, not a colour.
    expect(statusGlyph('done').getAttribute('class')).toContain('status-glyph')
    expect(statusGlyph('done').classList.contains('status-glyph-done')).toBe(true)
    expect(statusGlyph('executing').classList.contains('status-glyph-executing')).toBe(true)
  })
})

describe('verdictDot', () => {
  it('is green when all pass, red when any fail, neutral when none run', () => {
    expect(verdictDot(3, 3).classList.contains('verdict-dot-pass')).toBe(true)
    expect(verdictDot(2, 3).classList.contains('verdict-dot-fail')).toBe(true)
    expect(verdictDot(0, 0).classList.contains('verdict-dot-none')).toBe(true)
  })
})
