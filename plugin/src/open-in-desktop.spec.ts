import { describe, expect, it, vi } from 'vitest'
import { redirectOpenToDesktop, resolveOpenPort, shellForwarder, type DesktopOpenTarget } from './open-in-desktop.ts'

describe('resolveOpenPort', () => {
  it('reads a positive integer port', () => {
    expect(resolveOpenPort('43117')).toBe(43117)
  })

  it('is undefined when the shell set no port', () => {
    expect(resolveOpenPort(undefined)).toBeUndefined()
    expect(resolveOpenPort('')).toBeUndefined()
  })

  it('rejects non-port values', () => {
    expect(resolveOpenPort('0')).toBeUndefined()
    expect(resolveOpenPort('-5')).toBeUndefined()
    expect(resolveOpenPort('nope')).toBeUndefined()
    expect(resolveOpenPort('80.5')).toBeUndefined()
    expect(resolveOpenPort('99999')).toBeUndefined()
  })
})

describe('shellForwarder', () => {
  it('POSTs the path to the shell open endpoint on loopback', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    await shellForwarder(43117, fetchImpl as unknown as typeof fetch)('/proj/report.html')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:43117/open')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ path: '/proj/report.html' })
  })

  it('reports handled when the shell answers 200', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    expect(await shellForwarder(1, fetchImpl as unknown as typeof fetch)('/x')).toBe(true)
  })

  it('reports not-handled when the shell answers 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await shellForwarder(1, fetchImpl as unknown as typeof fetch)('/x')).toBe(false)
  })
})

describe('redirectOpenToDesktop', () => {
  it('forwards the path to the shell and does not call the native opener when the shell handles it', async () => {
    const native = vi.fn(async () => undefined)
    const target: DesktopOpenTarget = { openPath: native }
    const forward = vi.fn(async () => true)

    redirectOpenToDesktop(target, forward)
    await target.openPath!('/proj/report.html')

    expect(forward).toHaveBeenCalledWith('/proj/report.html')
    expect(native).not.toHaveBeenCalled()
  })

  it('falls back to the native opener when the shell declines the path', async () => {
    const native = vi.fn(async () => undefined)
    const signal = new AbortController().signal
    const target: DesktopOpenTarget = { openPath: native }

    redirectOpenToDesktop(target, async () => false)
    await target.openPath!('/outside/thing.txt', signal)

    expect(native).toHaveBeenCalledWith('/outside/thing.txt', signal)
  })

  it('falls back to the native opener when forwarding to the shell throws', async () => {
    const native = vi.fn(async () => undefined)
    const target: DesktopOpenTarget = { openPath: native }

    redirectOpenToDesktop(target, async () => {
      throw new Error('shell unreachable')
    })
    await target.openPath!('/proj/main.py')

    expect(native).toHaveBeenCalledWith('/proj/main.py', undefined)
  })

  it('is a no-op when the target exposes no native opener', () => {
    const target: DesktopOpenTarget = {}
    expect(() => redirectOpenToDesktop(target, async () => true)).not.toThrow()
    expect(target.openPath).toBeUndefined()
  })
})
