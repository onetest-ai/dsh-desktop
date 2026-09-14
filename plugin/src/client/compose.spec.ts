import { beforeEach, describe, expect, it, vi } from 'vitest'
import { composerOptions, reportComposerOptions, runCompose, startCompose } from './compose.ts'
import { appendToComposer } from './composer.ts'
import type { ComposerOptions, ComposeRequest } from './desktop.ts'

// The composer helper is the DOM fallback path; mock it so a test asserts that
// it was reached without standing up a real (invisible-in-jsdom) textarea.
vi.mock('./composer.ts', () => ({ appendToComposer: vi.fn() }))

/** An observable whose snapshot a test can move (mirrors the runtime's feed). */
function observable<T>(initial: T): {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(next: T): void
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
  }
}

interface SessionSnapshot {
  current: string | undefined
  byId: Record<string, { cwd?: string }>
}
interface WorkspaceSnapshot {
  items: { workspaceId: string; path: string; title: string }[]
}

const IN_DEMO: SessionSnapshot = { current: 's1', byId: { s1: { cwd: '/p/demo' } } }
const PROJECTS: WorkspaceSnapshot = {
  items: [
    { workspaceId: 'w-demo', path: '/p/demo', title: 'demo' },
    { workspaceId: 'w-other', path: '/p/other', title: 'other' },
  ],
}

/** A session face with spied verbs, plus the services that resolve to it. */
function runtime(
  session = { prompt: vi.fn().mockResolvedValue(undefined), command: vi.fn().mockResolvedValue(undefined) },
) {
  return {
    session,
    sessions: { list: observable<SessionSnapshot>(IN_DEMO), binding: vi.fn(() => ({ session })) },
    workspaces: { list: observable<WorkspaceSnapshot>(PROJECTS), startSession: vi.fn() },
  }
}

beforeEach(() => {
  vi.mocked(appendToComposer).mockClear()
})

describe('runCompose', () => {
  it('switches project only when the request names a different one', async () => {
    const r = runtime()
    await runCompose(r.sessions, r.workspaces, { text: 'hi', workspaceId: 'w-other', send: true })
    expect(r.workspaces.startSession).toHaveBeenCalledWith('w-other')
  })

  it('does not switch project when the request names the current one', async () => {
    const r = runtime()
    await runCompose(r.sessions, r.workspaces, { text: 'hi', workspaceId: 'w-demo', send: true })
    expect(r.workspaces.startSession).not.toHaveBeenCalled()
  })

  it('does not switch project when the request names none', async () => {
    const r = runtime()
    await runCompose(r.sessions, r.workspaces, { text: 'hi', send: true })
    expect(r.workspaces.startSession).not.toHaveBeenCalled()
  })

  it('sends the prompt through the session when asked to send', async () => {
    const r = runtime()
    await runCompose(r.sessions, r.workspaces, { text: 'ship it', send: true })
    expect(r.session.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'ship it' }], 'queue')
    expect(appendToComposer).not.toHaveBeenCalled()
  })

  it('drops the text in the box when not sending', async () => {
    const r = runtime()
    await runCompose(r.sessions, r.workspaces, { text: 'draft', send: false })
    expect(appendToComposer).toHaveBeenCalledWith('draft')
    expect(r.session.prompt).not.toHaveBeenCalled()
  })

  it('switches the model with a slash command before sending', async () => {
    const r = runtime()
    await runCompose(r.sessions, r.workspaces, { text: 'hi', model: 'deepseek-v3', send: true })
    expect(r.session.command).toHaveBeenCalledWith('/model deepseek-v3')
    expect(r.session.prompt).toHaveBeenCalled()
  })

  // reason: there is no contract setter for the model, so a `/model` the
  // deployment does not understand must not sink the whole compose.
  it('swallows a failing model command and still sends', async () => {
    const r = runtime({
      prompt: vi.fn().mockResolvedValue(undefined),
      command: vi.fn().mockRejectedValue(new Error('no such command')),
    })
    await expect(
      runCompose(r.sessions, r.workspaces, { text: 'hi', model: 'nope', send: true }),
    ).resolves.toBeUndefined()
    expect(r.session.prompt).toHaveBeenCalled()
  })

  // reason: the text is the user's work — losing it because nothing is open
  // would be the worst outcome, so it falls back to the box.
  it('falls back to the box when no session can be resolved', async () => {
    const r = runtime()
    r.sessions.list.set({ current: undefined, byId: {} })
    await runCompose(r.sessions, r.workspaces, { text: 'orphan', send: true })
    expect(appendToComposer).toHaveBeenCalledWith('orphan')
    expect(r.session.prompt).not.toHaveBeenCalled()
  })
})

describe('composerOptions', () => {
  it('lists every project and marks the current session’s own', () => {
    expect(composerOptions(PROJECTS, IN_DEMO)).toEqual({
      workspaces: [
        { id: 'w-demo', title: 'demo', current: true },
        { id: 'w-other', title: 'other', current: false },
      ],
    })
  })

  it('marks none current when no session is open', () => {
    const opts = composerOptions(PROJECTS, { current: undefined, byId: {} })
    expect(opts.workspaces.every((w) => !w.current)).toBe(true)
  })

  // reason: this runtime exposes no model catalog feed, so there is nothing
  // truthful to list — the field is omitted, not sent empty.
  it('omits models entirely', () => {
    expect(composerOptions(PROJECTS, IN_DEMO).models).toBeUndefined()
  })
})

describe('reportComposerOptions', () => {
  it('reports the projects derived from the list, right away', () => {
    const r = runtime()
    const report = vi.fn()
    reportComposerOptions(r.workspaces, r.sessions, report)
    expect(report).toHaveBeenCalledWith({
      workspaces: [
        { id: 'w-demo', title: 'demo', current: true },
        { id: 'w-other', title: 'other', current: false },
      ],
    })
  })

  it('reports again when the project list changes', () => {
    const r = runtime()
    const report = vi.fn()
    reportComposerOptions(r.workspaces, r.sessions, report)
    r.workspaces.list.set({ items: [{ workspaceId: 'w-demo', path: '/p/demo', title: 'demo' }] })
    expect(report).toHaveBeenCalledTimes(2)
  })

  // reason: the feeds fire for every token and title; re-sending an unchanged
  // set would redraw the app's dropdowns under the user for nothing.
  it('says nothing when the options have not changed', () => {
    const r = runtime()
    const report = vi.fn()
    reportComposerOptions(r.workspaces, r.sessions, report)
    r.sessions.list.set({ ...IN_DEMO })
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('stops reporting when told to', () => {
    const r = runtime()
    const report = vi.fn()
    const stop = reportComposerOptions(r.workspaces, r.sessions, report)
    stop()
    r.workspaces.list.set({ items: [] })
    expect(report).toHaveBeenCalledTimes(1)
  })
})

describe('startCompose', () => {
  it('registers the compose handler and reports options through the bridge', () => {
    const r = runtime()
    let handler: ((req: ComposeRequest) => void) | undefined
    const reported: ComposerOptions[] = []
    const bridge = {
      onAddToChat: vi.fn(),
      onCompose: vi.fn((listener: (req: ComposeRequest) => void) => {
        handler = listener
      }),
      reportComposerOptions: (opts: ComposerOptions) => reported.push(opts),
    }
    const ctx = {
      sessions: r.sessions,
      workspaces: r.workspaces,
      effect: (execute: () => unknown) => execute(),
    } as unknown as Parameters<typeof startCompose>[0]

    startCompose(ctx, bridge)

    expect(bridge.onCompose).toHaveBeenCalled()
    expect(handler).toBeTypeOf('function')
    expect(reported[0]?.workspaces[0]).toEqual({ id: 'w-demo', title: 'demo', current: true })
  })

  // reason: an older desktop app has neither call; the plugin must load clean.
  it('does nothing extra when the bridge lacks the newer calls', () => {
    const r = runtime()
    const bridge = { onAddToChat: vi.fn() }
    const ctx = {
      sessions: r.sessions,
      workspaces: r.workspaces,
      effect: (execute: () => unknown) => execute(),
    } as unknown as Parameters<typeof startCompose>[0]
    expect(() => startCompose(ctx, bridge)).not.toThrow()
  })
})
