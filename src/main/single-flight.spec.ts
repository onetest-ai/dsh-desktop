import { describe, expect, it, vi } from 'vitest'
import { singleFlight } from './single-flight'

describe('singleFlight', () => {
  it('coalesces overlapping calls into a single run of the wrapped function', async () => {
    let resolveRun: (() => void) | undefined
    const fn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve
        }),
    )
    const run = singleFlight(fn)

    const first = run()
    const second = run()

    expect(fn).toHaveBeenCalledTimes(1)

    resolveRun?.()
    await Promise.all([first, second])

    expect(fn).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
  })

  it('starts a fresh run once the previous one has resolved', async () => {
    const fn = vi.fn(async () => {})
    const run = singleFlight(fn)

    await run()
    await run()

    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh run after the previous one rejects', async () => {
    let attempt = 0
    const fn = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
    })
    const run = singleFlight(fn)

    await expect(run()).rejects.toThrow('boom')
    await expect(run()).resolves.toBeUndefined()

    expect(fn).toHaveBeenCalledTimes(2)
  })
})
