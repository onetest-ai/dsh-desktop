import { describe, expect, it } from 'vitest'
import { loadableUrl, locate } from './view-tools'

const ROOTS = ['/p/demo', '/p/other']

describe('locate', () => {
  it('finds the project a path belongs to', () => {
    expect(locate('/p/demo/src/index.ts', ROOTS)).toEqual({ root: '/p/demo', relative: 'src/index.ts' })
  })

  it('locates the project directory itself', () => {
    expect(locate('/p/demo', ROOTS)).toEqual({ root: '/p/demo', relative: '' })
  })

  // reason: a project checked out inside another must resolve to the nearer
  // one, or its files would be read against the wrong root.
  it('prefers the longest matching root', () => {
    expect(locate('/p/demo/inner/file.ts', ['/p/demo', '/p/demo/inner'])).toEqual({
      root: '/p/demo/inner',
      relative: 'file.ts',
    })
  })

  // reason: these arguments come from the model, the least trusted input in
  // the app. A path outside every project is not something it may open.
  it.each([
    ['a path in no project', '/etc/passwd'],
    ['a sibling whose name merely starts the same', '/p/demo-other/file.ts'],
    ['a relative path', 'src/index.ts'],
    ['an empty path', ''],
  ])('refuses %s', (_case, path) => {
    expect(locate(path, ROOTS)).toBeUndefined()
  })

  it('refuses anything when no project is open', () => {
    expect(locate('/p/demo/src/index.ts', [])).toBeUndefined()
  })

  // reason: `resolve` collapses the traversal, so the result is compared
  // against the roots as a real path rather than as the text given.
  it('resolves a traversal before deciding', () => {
    expect(locate('/p/demo/../../etc/passwd', ROOTS)).toBeUndefined()
    expect(locate('/p/demo/src/../index.ts', ROOTS)).toEqual({ root: '/p/demo', relative: 'index.ts' })
  })
})

describe('loadableUrl', () => {
  it.each(['http://example.com', 'https://example.com/page?q=1'])('allows %s', (url) => {
    expect(loadableUrl(url)).toBe(true)
  })

  // reason: each of these either reaches the filesystem, runs script in the
  // page, or carries its own payload.
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'app://pane/pane.html',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(loadableUrl(url)).toBe(false)
  })
})
