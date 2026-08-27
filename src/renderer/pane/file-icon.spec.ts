// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileIcon, iconFileFor } from './file-icon'

/** Whether an icon of that name was vendored. */
const vendored = (icon: string): boolean =>
  existsSync(join(import.meta.dirname, '..', '..', '..', 'vendor', 'vscode-icons', 'icons', icon))

describe('iconFileFor', () => {
  it.each([
    ['index.ts', 'file_type_typescript.svg'],
    ['notes.md', 'file_type_markdown.svg'],
    ['main.py', 'file_type_python.svg'],
    ['style.css', 'file_type_css.svg'],
    ['package.json', 'file_type_npm.svg'],
  ])('gives %s the icon a VS Code user already reads', (name, icon) => {
    expect(iconFileFor(name, false)).toBe(icon)
  })

  it('opens and closes the folder with the directory', () => {
    expect(iconFileFor('src', true, false)).not.toBe(iconFileFor('src', true, true))
  })

  // reason: the mapping knows more file types than this app carries icons for,
  // and a name it cannot place must still draw something.
  it('names an icon for anything at all', () => {
    for (const name of ['weird.qqq', 'noextension', '.hidden', '']) {
      expect(iconFileFor(name, false)).toMatch(/\.svg$/)
    }
  })

  // reason: an icon named but never vendored shows as a broken image, which
  // is worse than the default one.
  it.each([
    'index.ts', 'notes.md', 'main.py', 'style.css', 'package.json', 'app.vue', 'Dockerfile',
    'photo.png', 'archive.zip', 'a.yml', 'a.sh', 'a.sql', 'a.rs', 'a.go',
  ])('carries the icon it names for %s', (name) => {
    expect(vendored(iconFileFor(name, false))).toBe(true)
  })

  it.each(['src', 'docs', 'node_modules', 'tests'])('carries both folder icons for %s', (name) => {
    expect(vendored(iconFileFor(name, true, false))).toBe(true)
    expect(vendored(iconFileFor(name, true, true))).toBe(true)
  })

  // reason: the mapping knows hundreds of directory names and this app
  // carries the ones a project actually contains; the rest fall back in the
  // tree rather than being fetched.
  it('still names an icon for a directory it carries none for', () => {
    expect(iconFileFor('unlikely-directory-name', true)).toMatch(/\.svg$/)
  })

  it('carries the fallback it falls back to', () => {
    expect(vendored('default_file.svg')).toBe(true)
  })
})

describe('fileIcon', () => {
  it('renders an image pointing at the vendored icon', () => {
    const image = fileIcon('index.ts', false)
    expect(image.getAttribute('src')).toBe('icons/file_type_typescript.svg')
    // Decorative: the name beside it is what a screen reader should read.
    expect(image.alt).toBe('')
  })

  it('falls back when the icon it named is missing', () => {
    const image = fileIcon('weird.qqq', false)
    image.dispatchEvent(new Event('error'))
    expect(image.getAttribute('src')).toBe('icons/default_file.svg')
  })

  it('does not loop when the fallback itself is missing', () => {
    const image = fileIcon('weird.qqq', false)
    image.dispatchEvent(new Event('error'))
    image.dispatchEvent(new Event('error'))
    expect(image.getAttribute('src')).toBe('icons/default_file.svg')
  })
})
