import { describe, expect, it, vi } from 'vitest'
import { absoluteFileFromAddress, installFileOpenRedirect } from './open-file.ts'

describe('absoluteFileFromAddress', () => {
  const cwd = (id: string) => (id === 's1' ? '/proj' : undefined)

  it('resolves a workspace-relative file address against the session cwd', () => {
    expect(absoluteFileFromAddress('dsh-resource://file/session/s1/out/report.html', cwd)).toBe('/proj/out/report.html')
  })

  it('decodes percent-encoded path segments', () => {
    expect(absoluteFileFromAddress('dsh-resource://file/session/s1/my%20docs/a%20b.html', cwd)).toBe('/proj/my docs/a b.html')
  })

  it('returns an already-absolute path as-is, ignoring the cwd', () => {
    expect(absoluteFileFromAddress('dsh-resource://file/session/s1//abs/x.html', () => undefined)).toBe('/abs/x.html')
  })

  it('is undefined for a non-file resource address', () => {
    expect(absoluteFileFromAddress('dsh-resource://page/session/s1/thing', cwd)).toBeUndefined()
    expect(absoluteFileFromAddress('https://example.com/x', cwd)).toBeUndefined()
  })

  it('is undefined for the workspace root itself (empty path)', () => {
    expect(absoluteFileFromAddress('dsh-resource://file/session/s1/', cwd)).toBeUndefined()
  })

  it('is undefined when a relative address names a session with no known cwd', () => {
    expect(absoluteFileFromAddress('dsh-resource://file/session/other/x.html', cwd)).toBeUndefined()
  })
})

describe('installFileOpenRedirect', () => {
  function ctxWith(openResource: (a: string, o?: unknown) => unknown) {
    return {
      sidebarRight: { openResource },
      sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/proj' } } }) } },
    }
  }

  it('routes a file open to the desktop bridge and skips the harness tab when a pane takes it', async () => {
    const original = vi.fn()
    const ctx = ctxWith(original)
    const openPath = vi.fn(async () => true)
    installFileOpenRedirect(ctx, { onAddToChat: () => {}, openPath })

    ctx.sidebarRight.openResource('dsh-resource://file/session/s1/out/report.html')
    await Promise.resolve()
    expect(openPath).toHaveBeenCalledWith('/proj/out/report.html')
    expect(original).not.toHaveBeenCalled()
  })

  it('falls back to the harness tab when the pane declines the file', async () => {
    const original = vi.fn()
    const ctx = ctxWith(original)
    installFileOpenRedirect(ctx, { onAddToChat: () => {}, openPath: async () => false })

    ctx.sidebarRight.openResource('dsh-resource://file/session/s1/out/report.html')
    await Promise.resolve()
    await Promise.resolve()
    expect(original).toHaveBeenCalledWith('dsh-resource://file/session/s1/out/report.html', undefined)
  })

  it('leaves non-file resources to the harness untouched', () => {
    const original = vi.fn()
    const ctx = ctxWith(original)
    const openPath = vi.fn(async () => true)
    installFileOpenRedirect(ctx, { onAddToChat: () => {}, openPath })

    ctx.sidebarRight.openResource('dsh-resource://page/session/s1/thing')
    expect(openPath).not.toHaveBeenCalled()
    expect(original).toHaveBeenCalledWith('dsh-resource://page/session/s1/thing', undefined)
  })

  it('does nothing when the desktop bridge cannot open paths (older app)', () => {
    const original = vi.fn()
    const ctx = ctxWith(original)
    installFileOpenRedirect(ctx, { onAddToChat: () => {} })
    // openResource is left as the harness's own.
    expect(ctx.sidebarRight.openResource).toBe(original)
  })
})
