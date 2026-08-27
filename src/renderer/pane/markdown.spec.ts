// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isMarkdown, openMarkdownLink, renderMarkdown } from './markdown'

describe('isMarkdown', () => {
  it.each(['notes.md', 'README.MD', 'doc.markdown', 'a/b/c.md'])('renders %s', (name) => {
    expect(isMarkdown(name)).toBe(true)
  })

  it.each(['index.ts', 'notes.txt', 'Makefile', 'md', '.md'])('does not render %s', (name) => {
    expect(isMarkdown(name)).toBe(false)
  })
})

describe('renderMarkdown', () => {
  it('renders headings, lists, and code', () => {
    const html = renderMarkdown('# Title\n\n- one\n- two\n\n`code`\n')
    expect(html).toContain('<h1')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<code>code</code>')
  })

  it('renders GitHub tables, which is most of what a report is', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
  })

  // reason: this text comes from a file on disk, often one an agent just
  // wrote, and this page holds the preload that reaches the filesystem.
  it.each([
    ['a script tag', '<script>window.stolen = 1</script>', 'script'],
    ['an inline handler', '<img src="x" onerror="window.stolen = 1">', 'onerror'],
    ['a javascript: link', '[click](javascript:alert(1))', 'javascript:'],
    ['a data: image', '<img src="data:text/html,<script>alert(1)</script>">', 'data:'],
    ['an iframe', '<iframe src="https://example.com"></iframe>', '<iframe'],
  ])('strips %s', (_case, markdown, forbidden) => {
    expect(renderMarkdown(markdown).toLowerCase()).not.toContain(forbidden)
  })

  it('keeps an ordinary link and an ordinary image', () => {
    const html = renderMarkdown('[docs](https://example.com) ![shot](./shot.png)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('src="./shot.png"')
  })
})

describe('openMarkdownLink', () => {
  /** The anchor an `<a href>` in rendered markdown produces. */
  const anchor = (href: string): Element => {
    const element = document.createElement('a')
    element.setAttribute('href', href)
    return element
  }

  it.each(['https://example.com', 'http://localhost:3000/x'])('hands %s to the browser', (href) => {
    expect(openMarkdownLink(anchor(href))).toBe(href)
  })

  // reason: a preview is not a browser. Following a link in place would
  // replace the rendered file with a web page, with no way back.
  it.each(['./other.md', '#section', 'mailto:someone@example.com', ''])('opens nothing for %s', (href) => {
    expect(openMarkdownLink(anchor(href))).toBeUndefined()
  })

  it('opens nothing for a click that was not on a link', () => {
    expect(openMarkdownLink(document.createElement('p'))).toBeUndefined()
    expect(openMarkdownLink(null)).toBeUndefined()
  })

  it('finds the link when the click landed on something inside it', () => {
    const link = anchor('https://example.com')
    const strong = document.createElement('strong')
    link.append(strong)
    expect(openMarkdownLink(strong)).toBe('https://example.com')
  })
})
