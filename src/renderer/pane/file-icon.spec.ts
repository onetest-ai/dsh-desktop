// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileIcon, iconFileFor } from './file-icon'
// Each generated module exports one named table; the names differ per file.
import { FileNamesToIcon } from 'vscode-icons-js/dist/generated/FileNamesToIcon.js'
import { FileExtensions1ToIcon } from 'vscode-icons-js/dist/generated/FileExtensions1ToIcon.js'
import { FileExtensions2ToIcon } from 'vscode-icons-js/dist/generated/FileExtensions2ToIcon.js'
import { LanguagesToIcon } from 'vscode-icons-js/dist/generated/LanguagesToIcon.js'
import { FolderNamesToIcon } from 'vscode-icons-js/dist/generated/FolderNamesToIcon.js'

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

  // reason: vscode-icons draws the plain expanded folder as a hollow outline,
  // which at sixteen pixels reads as an empty box beside the solid folder
  // above it. The twisty already says whether a folder is open.
  it('keeps the solid folder for a plain folder, open or closed', () => {
    expect(iconFileFor('demoqa-webtables', true, true)).toBe('default_folder.svg')
    expect(iconFileFor('demoqa-webtables', true, false)).toBe('default_folder.svg')
  })

  it('still opens a folder that has an icon of its own', () => {
    expect(iconFileFor('src', true, true)).toBe('folder_type_src_opened.svg')
    expect(iconFileFor('src', true, true)).not.toBe(iconFileFor('src', true, false))
  })

  // reason: JSON Lines is JSON, one object per line, and vscode-icons has no
  // icon for it — leaving it the only unmarked file among its neighbours.
  it('gives JSON Lines the JSON icon', () => {
    expect(iconFileFor('events.jsonl', false)).toBe(iconFileFor('events.json', false))
    expect(iconFileFor('events.ndjson', false)).toBe(iconFileFor('events.json', false))
  })

  it('borrows only by extension, never by a name that merely contains one', () => {
    expect(iconFileFor('jsonl', false)).toBe('default_file.svg')
  })

  // reason: the mapping knows more file types than this app carries icons for,
  // and a name it cannot place must still draw something.
  it('names an icon for anything at all', () => {
    for (const name of ['weird.qqq', 'noextension', '.hidden', '']) {
      expect(iconFileFor(name, false)).toMatch(/\.svg$/)
    }
  })

  // reason: the point of vendoring the whole set is that the mapping and the
  // icons agree. A name the mapping produces with no icon behind it is a
  // fallback the user sees as a wrong icon.
  it('carries an icon for every name the mapping can produce', () => {
    const named = new Set<string>()
    for (const table of [FileNamesToIcon, FileExtensions1ToIcon, FileExtensions2ToIcon, LanguagesToIcon]) {
      for (const value of Object.values(table)) if (typeof value === 'string') named.add(value)
    }
    // Folders name both a closed and an opened icon.
    for (const value of Object.values(FolderNamesToIcon)) {
      if (typeof value !== 'string') continue
      named.add(value)
      named.add(value.replace(/\.svg$/, '_opened.svg'))
    }
    const missing = [...named].filter((icon) => !vendored(icon)).sort()
    // The mapping package and the icon set are versioned separately, and
    // these three are names the older mapping still produces for icons the
    // newer set renamed or dropped. They fall back, which is what the
    // fallback is for — but the list must not quietly grow, which is what
    // this pins.
    expect(missing).toEqual(['file_type_light_zeit.svg', 'file_type_makefile.svg', 'file_type_webp.svg'])
    // A guard against the tables being read wrongly and the check passing on
    // an empty set.
    expect(named.size).toBeGreaterThan(500)
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
