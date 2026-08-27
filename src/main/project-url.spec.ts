import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectFilePath, projectFileUrl } from './project-url'

/** A project directory holding one file. */
function project(name = 'shot.png'): { root: string; name: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-projurl-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, name), 'x')
  writeFileSync(join(root, 'assets', 'deep.png'), 'x')
  return { root, name }
}

/** The path part of a URL this app built. */
const pathOf = (url: string): string => new URL(url).pathname

describe('projectFileUrl', () => {
  it('addresses a file by its project and path', () => {
    const url = projectFileUrl('app://pane', '/p/demo', 'assets/shot.png')
    expect(new URL(url).host).toBe('project')
    expect(url).toContain(encodeURIComponent('/p/demo'))
    expect(url).toContain('assets/shot.png')
  })

  // reason: a space or a `#` in a path would otherwise end the URL early or
  // start a fragment.
  it('escapes what a URL would otherwise read as structure', () => {
    const url = projectFileUrl('app://pane', '/p/my project', 'a#b/c d.png')
    expect(new URL(url).pathname).not.toContain('#')
    expect(projectFilePath(pathOf(url), ['/p/my project'])).toBeUndefined()
  })
})

describe('projectFilePath', () => {
  it('resolves a file inside a project the harness has opened', () => {
    const { root, name } = project()
    const url = projectFileUrl('app://pane', root, name)
    expect(projectFilePath(pathOf(url), [root])).toContain(name)
  })

  it('resolves a file in a subdirectory', () => {
    const { root } = project()
    const url = projectFileUrl('app://pane', root, 'assets/deep.png')
    expect(projectFilePath(pathOf(url), [root])).toContain('deep.png')
  })

  // reason: this scheme is reachable from any page this app loads, so it
  // follows the same rule every other read does.
  it('refuses a project the harness has not opened', () => {
    const { root, name } = project()
    const url = projectFileUrl('app://pane', root, name)
    expect(projectFilePath(pathOf(url), ['/somewhere/else'])).toBeUndefined()
  })

  it('refuses a traversal out of the project', () => {
    const { root } = project()
    const url = projectFileUrl('app://pane', root, '../../etc/passwd')
    expect(projectFilePath(pathOf(url), [root])).toBeUndefined()
  })

  it('refuses a symlink pointing out of the project', () => {
    const outside = project('secret.txt')
    const { root } = project()
    symlinkSync(join(outside.root, 'secret.txt'), join(root, 'link.txt'))
    const url = projectFileUrl('app://pane', root, 'link.txt')
    expect(projectFilePath(pathOf(url), [root])).toBeUndefined()
  })

  it.each([
    ['no path at all', '/'],
    ['only a project', '/%2Fp%2Fdemo'],
    ['a malformed escape', '/%2Fp%2Fdemo/%E0%A4%A'],
  ])('refuses %s', (_case, pathname) => {
    expect(projectFilePath(pathname, ['/p/demo'])).toBeUndefined()
  })

  it('refuses a file that does not exist', () => {
    const { root } = project()
    const url = projectFileUrl('app://pane', root, 'missing.png')
    expect(projectFilePath(pathOf(url), [root])).toBeUndefined()
  })
})
