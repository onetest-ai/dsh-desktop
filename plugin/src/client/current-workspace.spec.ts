import { describe, expect, it, vi } from 'vitest'
import { currentCwd, followCurrentWorkspace, type SessionList } from './current-workspace.ts'

/** An observable whose snapshot a test can move. */
function observable(initial: SessionList): {
  getSnapshot(): SessionList
  subscribe(listener: () => void): () => void
  set(next: SessionList): void
  listeners: number
} {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      state = next
      for (const listener of listeners) listener()
    },
    get listeners() {
      return listeners.size
    },
  }
}

const IN_DEMO: SessionList = { current: 's1', byId: { s1: { cwd: '/p/demo' }, s2: { cwd: '/p/other' } } }

describe('currentCwd', () => {
  it('reads the open session’s working directory', () => {
    expect(currentCwd(IN_DEMO)).toBe('/p/demo')
  })

  it.each([
    ['nothing is open', { current: undefined, byId: {} }],
    ['the open session is not in the list', { current: 's9', byId: { s1: { cwd: '/p/demo' } } }],
    ['the open session has no directory', { current: 's1', byId: { s1: {} } }],
  ])('reports nothing when %s', (_case, list) => {
    expect(currentCwd(list as SessionList)).toBeUndefined()
  })
})

describe('followCurrentWorkspace', () => {
  it('reports the directory it starts on', () => {
    const report = vi.fn()
    followCurrentWorkspace(observable(IN_DEMO), report)
    expect(report).toHaveBeenCalledWith('/p/demo')
  })

  // reason: this is the whole point — the harness knows which session is
  // open, and switching to one moves nothing on disk to infer it from.
  it('reports again when the user switches session', () => {
    const sessions = observable(IN_DEMO)
    const report = vi.fn()
    followCurrentWorkspace(sessions, report)
    sessions.set({ ...IN_DEMO, current: 's2' })
    expect(report).toHaveBeenNthCalledWith(2, '/p/other')
  })

  // reason: the list fires for every message, title, and token that lands,
  // and redrawing a file tree under the user for each would be unusable.
  it('says nothing when the directory has not changed', () => {
    const sessions = observable(IN_DEMO)
    const report = vi.fn()
    followCurrentWorkspace(sessions, report)
    sessions.set({ ...IN_DEMO })
    sessions.set({ ...IN_DEMO, byId: { ...IN_DEMO.byId, s1: { cwd: '/p/demo' } } })
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('says nothing while no session is open', () => {
    const report = vi.fn()
    followCurrentWorkspace(observable({ current: undefined, byId: {} }), report)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports the first directory once one opens', () => {
    const sessions = observable({ current: undefined, byId: {} } as SessionList)
    const report = vi.fn()
    followCurrentWorkspace(sessions, report)
    sessions.set(IN_DEMO)
    expect(report).toHaveBeenCalledWith('/p/demo')
  })

  it('stops reporting when told to', () => {
    const sessions = observable(IN_DEMO)
    const report = vi.fn()
    const stop = followCurrentWorkspace(sessions, report)
    stop()
    sessions.set({ ...IN_DEMO, current: 's2' })
    expect(report).toHaveBeenCalledTimes(1)
    expect(sessions.listeners).toBe(0)
  })
})
