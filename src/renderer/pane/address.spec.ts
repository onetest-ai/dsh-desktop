import { describe, expect, it } from 'vitest'
import { normalizeAddress } from './address'

describe('normalizeAddress', () => {
  it('keeps a URL that already names its scheme', () => {
    expect(normalizeAddress('https://example.com/page?q=1')).toBe('https://example.com/page?q=1')
    expect(normalizeAddress('http://localhost:3000')).toBe('http://localhost:3000')
  })

  // reason: that is what typing `example.com` into any address bar means.
  it.each([
    ['example.com', 'https://example.com'],
    ['example.com/page', 'https://example.com/page'],
    ['localhost:3000', 'https://localhost:3000'],
  ])('gives %s a scheme', (typed, expected) => {
    expect(normalizeAddress(typed)).toBe(expected)
  })

  it('ignores surrounding whitespace', () => {
    expect(normalizeAddress('  example.com  ')).toBe('https://example.com')
  })

  // reason: this bar loads pages. A file: or javascript: URL typed here would
  // be the same reach the view tools refuse.
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'about:blank'])(
    'refuses %s',
    (typed) => {
      expect(normalizeAddress(typed)).toBeUndefined()
    },
  )

  it.each([['nothing at all', ''], ['only spaces', '   '], ['a scheme with no host', 'https://']])(
    'refuses %s',
    (_case, typed) => {
      expect(normalizeAddress(typed)).toBeUndefined()
    },
  )
})
