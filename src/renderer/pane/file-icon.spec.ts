import { describe, expect, it } from 'vitest'
import { fileGlyph } from './file-icon'
import { GLYPHS } from './icons'

describe('fileGlyph', () => {
  it('opens and closes the folder with the directory', () => {
    expect(fileGlyph('src', true, false)).toBe('folderClosed')
    expect(fileGlyph('src', true, true)).toBe('folderOpen')
  })

  it.each(['index.ts', 'app.tsx', 'main.py', 'style.css', 'App.vue'])('gives %s the code glyph', (name) => {
    expect(fileGlyph(name, false)).toBe('code')
  })

  it.each(['config.yaml', 'package.json', 'data.csv', 'query.sql'])('gives %s the data glyph', (name) => {
    expect(fileGlyph(name, false)).toBe('data')
  })

  it.each(['notes.md', 'readme.txt', 'run.log'])('gives %s the document glyph', (name) => {
    expect(fileGlyph(name, false)).toBe('document')
  })

  it('matches the extension whatever its case', () => {
    expect(fileGlyph('README.MD', false)).toBe('document')
    expect(fileGlyph('Index.TS', false)).toBe('code')
  })

  // reason: a wrong icon is worse than none, because it is read as
  // information about a file the app has not opened.
  it.each(['archive.zip', 'photo.png', 'Makefile', 'noextension', '.env', 'font.woff2'])(
    'draws no glyph for %s',
    (name) => {
      expect(fileGlyph(name, false)).toBeUndefined()
    },
  )

  it('only ever names a glyph that exists', () => {
    for (const name of ['a.ts', 'b.md', 'c.json', 'dir']) {
      const glyph = fileGlyph(name, name === 'dir')
      if (glyph !== undefined) expect(GLYPHS).toHaveProperty(glyph)
    }
    expect(GLYPHS).toHaveProperty(fileGlyph('dir', true) ?? '')
    expect(GLYPHS).toHaveProperty(fileGlyph('dir', true, true) ?? '')
  })
})
