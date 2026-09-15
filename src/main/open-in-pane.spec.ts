import { describe, expect, it, vi } from 'vitest'
import { openPathInPane, type OpenInPaneDeps } from './open-in-pane'

/** A deps set over one project at `/proj`, with every file resolving inside it. */
function depsOver(roots: string[]): { deps: OpenInPaneDeps; openEditor: ReturnType<typeof vi.fn>; openWeb: ReturnType<typeof vi.fn> } {
  const openEditor = vi.fn()
  const openWeb = vi.fn()
  const deps: OpenInPaneDeps = {
    roots: () => roots,
    resolve: (root, relative) => (roots.includes(root) ? `${root}/${relative}` : undefined),
    isWebPage: (name) => name.endsWith('.html') || name.endsWith('.htm'),
    webPageUrl: (root, relative) => `file://${root}/${relative}`,
    openEditor,
    openWeb,
  }
  return { deps, openEditor, openWeb }
}

describe('openPathInPane', () => {
  it('opens an html file in the web pane and reports handled', () => {
    const { deps, openEditor, openWeb } = depsOver(['/proj'])
    expect(openPathInPane(deps, '/proj/out/report.html')).toBe(true)
    expect(openWeb).toHaveBeenCalledWith('file:///proj/out/report.html')
    expect(openEditor).not.toHaveBeenCalled()
  })

  it('opens a non-web file in the editor pane and reports handled', () => {
    const { deps, openEditor, openWeb } = depsOver(['/proj'])
    expect(openPathInPane(deps, '/proj/src/main.py')).toBe(true)
    expect(openEditor).toHaveBeenCalledWith('/proj', 'src/main.py')
    expect(openWeb).not.toHaveBeenCalled()
  })

  it('reports not-handled for a path inside no known project', () => {
    const { deps, openEditor, openWeb } = depsOver(['/proj'])
    expect(openPathInPane(deps, '/elsewhere/file.txt')).toBe(false)
    expect(openEditor).not.toHaveBeenCalled()
    expect(openWeb).not.toHaveBeenCalled()
  })

  it('reports not-handled when an html file will not resolve to a viewable url', () => {
    const { deps, openWeb } = depsOver(['/proj'])
    deps.webPageUrl = () => undefined
    expect(openPathInPane(deps, '/proj/report.html')).toBe(false)
    expect(openWeb).not.toHaveBeenCalled()
  })

  it('reports not-handled for a path that resolves outside the root (traversal/symlink)', () => {
    const { deps } = depsOver(['/proj'])
    deps.resolve = () => undefined
    expect(openPathInPane(deps, '/proj/escape.txt')).toBe(false)
  })

  it('picks the containing project among several and derives its relative path', () => {
    const { deps, openEditor } = depsOver(['/a', '/b'])
    expect(openPathInPane(deps, '/b/deep/note.md')).toBe(true)
    expect(openEditor).toHaveBeenCalledWith('/b', 'deep/note.md')
  })
})
