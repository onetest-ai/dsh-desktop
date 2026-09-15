import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('does not list files behind a symlink inside icons/ that escapes the workspace', () => {
    // The attack: commit a symlink under the icon folder pointing at anything
    // on disk. statSync/readdirSync follow it transparently — only an explicit
    // check against the fence catches it.
    const outside = mkdtempSync(join(tmpdir(), 'icons-outside-'))
    writeFileSync(join(outside, 'secret-logo.png'), PNG)
    symlinkSync(outside, join(archRoot(project), 'icons', 'leak'))
    expect(listIcons(project).map((icon) => icon.slug)).not.toContain('leak/secret-logo')
  })

  it('does not list files behind a symlink inside a declared iconPaths folder that escapes the workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'icons-outside-'))
    writeFileSync(join(outside, 'secret-logo.png'), PNG)
    symlinkSync(outside, join(project, 'docs', 'icons', 'leak'))
    expect(listIcons(project).map((icon) => icon.slug)).not.toContain('leak/secret-logo')
  })

  it('still lists files behind a symlink that stays within the workspace, even in another folder', () => {
    // Not every symlink is an attack — `iconPaths` already lets a project name
    // a folder like `docs/icons` outside `.dsh/arch/`, so a symlink from
    // inside icons/ to another folder of the SAME project is the same
    // statement by another spelling. The fence is the workspace, not the
    // icon folder being walked, so a target anywhere inside the project —
    // even one with no relation to icons/ — is followed, not refused.
    const brand = join(project, 'brand')
    mkdirSync(brand, { recursive: true })
    writeFileSync(join(brand, 'logo.png'), PNG)
    symlinkSync(brand, join(archRoot(project), 'icons', 'linked'))
    expect(listIcons(project).map((icon) => icon.slug)).toContain('linked/logo')
  })

  it('still lists files behind a symlink that stays within the same icon root', () => {
    // The narrower, same-folder case is legitimate too — kept alongside the
    // cross-folder case above so both directions of "within the workspace"
    // are covered by a real symlink.
    const vendor = join(archRoot(project), 'icons', 'vendor')
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, 'brand-logo.png'), PNG)
    symlinkSync(vendor, join(archRoot(project), 'icons', 'shared'))
    expect(listIcons(project).map((icon) => icon.slug)).toContain('shared/brand-logo')
  })

  it('lists nothing when .dsh/arch/icons itself is a symlink pointing outside the workspace', () => {
    // The quieter instance of the same gap: the built-in root was join()'d by
    // hand rather than resolved through the fence, so a symlinked icons/
    // directory itself was never checked.
    const freshProject = mkdtempSync(join(tmpdir(), 'icons-'))
    const outside = mkdtempSync(join(tmpdir(), 'icons-outside-'))
    writeFileSync(join(outside, 'secret-logo.png'), PNG)
    mkdirSync(archRoot(freshProject), { recursive: true })
    symlinkSync(outside, join(archRoot(freshProject), 'icons'))
    expect(listIcons(freshProject)).toEqual([])
  })
})
