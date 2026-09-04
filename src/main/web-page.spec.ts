import { describe, expect, it } from 'vitest'
import { isWebPage } from './web-page'

describe('isWebPage', () => {
  it('accepts the page extensions, whatever their case', () => {
    for (const name of ['index.html', 'a.htm', 'REPORT.HTML', 'deep/path/page.Htm']) {
      expect(isWebPage(name), name).toBe(true)
    }
  })

  // reason: these already open in a tab of their own, and two ways to look at
  // one file is a menu that has to be explained.
  it('refuses what the editor column already shows', () => {
    for (const name of ['notes.md', 'photo.png', 'paper.pdf', 'clip.mp4', 'main.ts']) {
      expect(isWebPage(name), name).toBe(false)
    }
  })

  // reason: a dotfile's leading dot introduces no extension, and a bare name
  // has none to read.
  it('refuses a name with no extension of its own', () => {
    for (const name of ['.html', 'Makefile', 'html', '']) {
      expect(isWebPage(name), name).toBe(false)
    }
  })
})
