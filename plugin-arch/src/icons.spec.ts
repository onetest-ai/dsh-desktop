import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { admitIcon, IconError, listIcons, MAX_ICON_BYTES, readIconPaths, sniffMediaType } from './icons.ts'
import { archRoot } from './paths.ts'

let project: string

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
])
const GIF = new TextEncoder().encode('GIF89a-------')

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'icons-'))
})

describe('sniffMediaType', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['SVG', SVG, 'image/svg+xml'],
    ['WebP', WEBP, 'image/webp'],
  ])('recognises %s from its bytes', (_case, bytes, expected) => {
    expect(sniffMediaType(bytes)).toBe(expected)
  })

  it('does not recognise an unsupported format', () => {
    expect(sniffMediaType(GIF)).toBeUndefined()
  })
})

describe('admitIcon', () => {
  it('trusts content over a lying extension', () => {
    // The caller may believe this is a PNG; the bytes say GIF, and the bytes win.
    expect(() => admitIcon(GIF)).toThrow(IconError)
  })

  it('refuses a file over the size cap', () => {
    expect(() => admitIcon(new Uint8Array(MAX_ICON_BYTES + 1))).toThrow(/too large/)
  })

  it('accepts a normal icon', () => {
    expect(admitIcon(PNG)).toBe('image/png')
  })
})

describe('readIconPaths', () => {
  it('is empty when there is no config', () => {
    expect(readIconPaths(project)).toEqual([])
  })

  it('reads declared paths', () => {
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), 'config.json'), '{"iconPaths":["docs/icons"]}')
    expect(readIconPaths(project)).toEqual(['docs/icons'])
  })

  it('drops a path that escapes the workspace', () => {
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), 'config.json'), '{"iconPaths":["../../etc","docs/icons"]}')
    expect(readIconPaths(project)).toEqual(['docs/icons'])
  })

  it('survives a malformed config rather than failing the plugin', () => {
    mkdirSync(archRoot(project), { recursive: true })
    writeFileSync(join(archRoot(project), 'config.json'), '{ not json')
    expect(readIconPaths(project)).toEqual([])
  })
})

describe('listIcons', () => {
  beforeEach(() => {
    mkdirSync(join(archRoot(project), 'icons', 'aws'), { recursive: true })
    writeFileSync(join(archRoot(project), 'icons', 'aws', 'ec2.svg'), SVG)
    writeFileSync(join(archRoot(project), 'icons', 'okta.png'), PNG)
    mkdirSync(join(project, 'docs', 'icons'), { recursive: true })
    writeFileSync(join(project, 'docs', 'icons', 'brand.png'), PNG)
    writeFileSync(join(archRoot(project), 'config.json'), '{"iconPaths":["docs/icons"]}')
  })

  it('namespaces a slug by its subfolder', () => {
    expect(listIcons(project).map((icon) => icon.slug)).toContain('aws/ec2')
  })

  it('includes icons from declared iconPaths', () => {
    expect(listIcons(project).map((icon) => icon.slug)).toContain('brand')
  })

  it('filters by query rather than returning everything', () => {
    expect(listIcons(project, 'ec2').map((icon) => icon.slug)).toEqual(['aws/ec2'])
  })

  it('ignores files that are not supported images', () => {
    writeFileSync(join(archRoot(project), 'icons', 'notes.txt'), 'hello')
    expect(listIcons(project).map((icon) => icon.slug)).not.toContain('notes')
  })

  it('is sorted, so output is stable', () => {
    const slugs = listIcons(project).map((icon) => icon.slug)
    expect(slugs).toEqual([...slugs].sort())
  })
})
