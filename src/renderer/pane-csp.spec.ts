import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The pane page's Content-Security-Policy.
 *
 * Read out of `pane.html` rather than asserted against a constant, because the
 * page is where it is declared and a copy here would be a second policy that
 * could drift from the one Chromium enforces. The page itself is the only
 * thing under test: there is no way to run the real renderer from vitest, so
 * these say what the policy permits and what it refuses, and the build is what
 * says the editor still loads under it.
 */
const html = readFileSync(join(import.meta.dirname, 'pane.html'), 'utf8')

/** The policy's `content`, or the empty string when the page declares none. */
const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1] ?? ''

/**
 * One directive's source list.
 * @param name - the directive to read.
 * @returns what it permits, as written.
 */
function directive(name: string): string {
  const found = policy
    .split(';')
    .map((one) => one.trim())
    .find((one) => one === name || one.startsWith(`${name} `))
  return found === undefined ? '' : found.slice(name.length).trim()
}

describe('the pane page’s content security policy', () => {
  // reason: this page holds the preload that reaches the filesystem, and the
  // board's detail renders markdown an agent wrote. The sanitiser keeps an
  // `<img src>`, so before this, opening a card issued a request to whatever
  // URL the file named, from the privileged page.
  it('permits nothing by default, so a remote fetch has to be named to happen', () => {
    expect(directive('default-src')).toBe("'none'")
  })

  // reason: the point of the policy. Every source list names this app's own
  // two hosts and nothing else — a `https:` anywhere in it would put the
  // remote fetch back for whichever kind of element carried it.
  it('names no remote source in any directive', () => {
    expect(policy).not.toMatch(/https?:/)
    expect(policy).not.toMatch(/\*/)
  })

  // reason: a policy that broke the editor would be worse than none — Monaco's
  // language services are workers loaded from this origin, which is the reason
  // the pane is served from a scheme at all rather than from a file.
  it('permits the editor’s own workers and script', () => {
    expect(directive('worker-src')).toBe("'self'")
    expect(directive('script-src')).toBe("'self'")
  })

  // reason: Monaco injects a `<style>` element and writes `element.style` on
  // nearly everything it draws; both are inline styles as far as CSP is
  // concerned, and neither can be covered by a nonce.
  it('permits the inline styles the editor writes as it draws', () => {
    expect(directive('style-src')).toContain("'unsafe-inline'")
    expect(directive('style-src')).toContain("'self'")
  })

  // reason: the editor column shows a picture, a video or a PDF out of the
  // open project, served under its own host — and `pane-bundle.css` carries
  // the squiggles and the empty-editor art as data URIs.
  it('permits this app’s own project files and the bundle’s data URIs', () => {
    expect(directive('img-src')).toBe("'self' app://project data:")
    expect(directive('media-src')).toBe("'self' app://project")
    expect(directive('object-src')).toBe('app://project')
    expect(directive('font-src')).toBe("'self'")
  })
})
