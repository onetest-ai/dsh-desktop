// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { PAGE_TEXT_LIMIT, pageTextScript } from './page-text'

/**
 * Run the extraction script against a document, as `executeJavaScript` does.
 * @param html - the page's body markup.
 * @param limit - the character bound to apply.
 * @returns what the script returns.
 */
function extract(html: string, limit = PAGE_TEXT_LIMIT): { title: string; url: string; text: string } {
  document.body.innerHTML = html
  // jsdom does not lay text out, so `innerText` is absent; the script reads it
  // and this stands in with the same semantics for these fixtures.
  for (const element of [document.body, ...document.body.querySelectorAll('*')]) {
    Object.defineProperty(element, 'innerText', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? ''
      },
    })
  }
  return eval(pageTextScript(limit)) as { title: string; url: string; text: string }
}

describe('pageTextScript', () => {
  it('reads the page title and location', () => {
    document.title = 'A page'
    expect(extract('<p>hello</p>')).toMatchObject({ title: 'A page', url: expect.stringContaining('http') })
  })

  // reason: nav, footer, and cookie banners are noise in something read for
  // content.
  it('prefers an article over the whole body', () => {
    const out = extract('<nav>skip me</nav><article>the content</article><footer>and me</footer>')
    expect(out.text).toBe('the content')
  })

  it('falls back to main, then to the body', () => {
    expect(extract('<nav>skip me</nav><main>the content</main>').text).toBe('the content')
    expect(extract('<div>just a div</div>').text).toBe('just a div')
  })

  it('collapses runs of blank lines', () => {
    expect(extract('<main>a\n\n\n\n\nb</main>').text).toBe('a\n\nb')
  })

  // reason: a page can be enormous and the whole thing lands in the model's
  // context; a silent cut would have it reading a beginning as a whole.
  it('truncates a long page and says so', () => {
    const out = extract(`<main>${'x'.repeat(500)}</main>`, 100)
    expect(out.text).toContain('truncated at 100 characters')
    expect(out.text.startsWith('x'.repeat(100))).toBe(true)
  })

  it('leaves a page under the limit whole', () => {
    const out = extract('<main>short</main>', 100)
    expect(out.text).toBe('short')
  })
})
