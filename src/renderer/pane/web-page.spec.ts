import { describe, expect, it } from 'vitest'
import { isWebPage } from './web-page'

describe('isWebPage', () => {
  it.each(['index.html', 'a/b/page.HTM', 'report.htm', 'x.HTML'])('opens %s in the web view', (name) => {
    expect(isWebPage(name)).toBe(true)
  })

  it.each(['notes.md', 'data.csv', 'index.ts', 'html', '.html', 'page.htmlx'])('does not open %s in the web view', (name) => {
    expect(isWebPage(name)).toBe(false)
  })
})
