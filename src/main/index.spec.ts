import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartOptions } from './server'

/**
 * Orchestration tests for the main entry point.
 *
 * `index.ts` owns the app's mutable cross-cutting state — the current child,
 * its generation, the lifecycle chain, and the quit flag — so it is driven here
 * through a faked `electron` module: the fake records the handlers the module
 * registers and lets a test fire them in the orders the real app can produce.
 */

const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown

  const handlers = new Map<string, Handler[]>()
  const windowHandlers = new Map<string, Handler[]>()
  let readyResolve: () => void = () => {}
  let whenReady: Promise<void> = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  /** Arm a fresh whenReady, so a later test does not inherit an already-ready app. */
  function resetReady(): void {
    whenReady = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
  }

  const window = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    loadURL: vi.fn(),
    on: vi.fn((name: string, handler: Handler) => {
      windowHandlers.set(name, [...(windowHandlers.get(name) ?? []), handler])
      return window
    }),
  }

  const app = {
    requestSingleInstanceLock: vi.fn(() => true),
    setAsDefaultProtocolClient: vi.fn(),
    getPath: vi.fn(() => '/tmp/dsh-desktop-test-userdata'),
    whenReady: vi.fn(() => whenReady),
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return app
    }),
    quit: vi.fn(() => {
      // The real app.quit() emits before-quit, and a handler that calls
      // preventDefault cancels the quit until it calls quit() again.
      void emit('before-quit', quitEvent())
    }),
  }

  const globalShortcut = {
    register: vi.fn(() => true),
    unregisterAll: vi.fn(),
  }

  function quitEvent(): { preventDefault: () => void; prevented: boolean } {
    const event = {
      prevented: false,
      preventDefault: () => {
        event.prevented = true
      },
    }
    quitEvents.push(event)
    return event
  }

  const quitEvents: Array<{ preventDefault: () => void; prevented: boolean }> = []

  function emit(name: string, ...args: unknown[]): Promise<unknown[]> {
    return Promise.all((handlers.get(name) ?? []).map((handler) => handler(...args)))
  }

  function emitWindow(name: string, ...args: unknown[]): Promise<unknown[]> {
    return Promise.all((windowHandlers.get(name) ?? []).map((handler) => handler(...args)))
  }

  return {
    app,
    window,
    globalShortcut,
    handlers,
    windowHandlers,
    quitEvents,
    emit,
    emitWindow,
    quitEvent,
    resetReady,
    ready: () => readyResolve(),
  }
})

vi.mock('electron', () => ({
  app: fake.app,
  BrowserWindow: class {},
  globalShortcut: fake.globalShortcut,
  Notification: class {
    show(): void {}
  },
}))

const createWindow = vi.fn(() => fake.window)
const showError = vi.fn()
vi.mock('./window', () => ({
  createWindow: (...args: unknown[]) => createWindow(...(args as [])),
  showError: (...args: unknown[]) => showError(...(args as [])),
  installMenu: vi.fn(),
}))

const setTrayStatus = vi.fn()
let trayActions: { toggleWindow(): void; restart(): void; quit(): void } | undefined
vi.mock('./tray', () => ({
  createTray: (actions: { toggleWindow(): void; restart(): void; quit(): void }) => {
    trayActions = actions
    return { setStatus: setTrayStatus, destroy: vi.fn() }
  },
}))

vi.mock('./notify', () => ({
  startNotifyListener: vi.fn(async () => ({ port: 1, close: async () => {} })),
}))

vi.mock('./config', () => ({
  loadConfig: vi.fn(() => ({
    configured: true,
    config: {
      harness: { kind: 'local', repo: '/tmp/harness' },
      notifyPort: 44444,
      hotkey: 'CommandOrControl+Shift+D',
    },
  })),
}))

vi.mock('./preflight', () => ({ preflight: vi.fn(() => ({ ok: true })) }))

vi.mock('./runtime-files', () => ({
  writeRuntimeFiles: vi.fn(() => ({ patchPath: '/tmp/p.yml', hooksPath: '/tmp/h.json' })),
}))

/** One spawned harness child, controlled by the test. */
interface FakeChild {
  options: StartOptions
  stop: ReturnType<typeof vi.fn>
  /** Resolve `startServer` as if the ready line had arrived. */
  ready(url?: string): void
  /** Reject `startServer` as if the child had failed to become ready. */
  failToStart(message: string): void
  /** Fire the post-readiness exit callback this child was given. */
  exit(code: number, tail: string): void
  /** Release a stop that was made to hang; only for children stopped with `hangStop`. */
  releaseStop(): void
}

const children: FakeChild[] = []
const startServer = vi.fn()
vi.mock('./server', () => ({
  startServer: (options: StartOptions) => startServer(options),
  dshWebCommand: vi.fn(() => ({ command: 'pnpm', args: [], cwd: '/tmp/harness' })),
}))

/** Whether the next spawned child's `stop()` hangs until `releaseStop()`. */
let hangStop = false

function installStartServer(): void {
  startServer.mockImplementation(
    (options: StartOptions) =>
      new Promise((resolve, reject) => {
        let release: () => void = () => {}
        const hanging = hangStop
        let settled = false
        // A stop before readiness kills the child, and the real startServer
        // rejects on that exit rather than waiting out its readiness timeout.
        const finishStop = (done: () => void): void => {
          if (!settled) {
            settled = true
            reject(new Error('dsh-desktop: the harness exited with code null before starting.'))
          }
          done()
        }
        const stop = vi.fn(
          () =>
            new Promise<void>((done) => {
              if (!hanging) {
                finishStop(done)
                return
              }
              release = () => finishStop(done)
            }),
        )
        options.onSpawned?.(stop)
        children.push({
          options,
          stop,
          ready: (url = 'http://127.0.0.1:5000') => {
            settled = true
            resolve({ url, stop })
          },
          failToStart: (message) => {
            settled = true
            reject(new Error(message))
          },
          exit: (code, tail) => options.onExit?.(code, tail),
          releaseStop: () => release(),
        })
      }),
  )
}

/** Import the entry point fresh, so its module state starts clean. */
async function loadIndex(): Promise<void> {
  await import('./index')
}

/** Let queued microtasks and the lifecycle chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** Drive the app to a booted, ready harness. */
async function bootReady(): Promise<FakeChild> {
  await loadIndex()
  fake.ready()
  await vi.waitFor(() => expect(children.length).toBe(1))
  children[0].ready()
  await settle()
  return children[0]
}

beforeEach(() => {
  vi.resetModules()
  children.length = 0
  fake.handlers.clear()
  fake.windowHandlers.clear()
  fake.quitEvents.length = 0
  trayActions = undefined
  hangStop = false
  vi.clearAllMocks()
  fake.resetReady()
  fake.app.requestSingleInstanceLock.mockReturnValue(true)
  fake.app.getPath.mockReturnValue('/tmp/dsh-desktop-test-userdata')
  fake.globalShortcut.register.mockReturnValue(true)
  fake.window.isDestroyed.mockReturnValue(false)
  installStartServer()
})

describe('boot', () => {
  it('loads the harness URL once the child reports ready', async () => {
    const child = await bootReady()
    expect(child.options.timeoutMs).toBeGreaterThan(0)
    expect(fake.window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5000')
    expect(setTrayStatus).toHaveBeenLastCalledWith('running')
  })

  it('shows the failure pane when the child never becomes ready', async () => {
    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].failToStart('no URL')
    await settle()
    expect(children[0].stop).toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(fake.window, 'The harness failed to start', expect.stringContaining('no URL'))
  })

  it("reports the live child's exit in the window", async () => {
    const child = await bootReady()
    child.exit(9, 'stderr tail')
    await settle()
    expect(showError).toHaveBeenCalledWith(fake.window, 'The harness exited (code 9)', 'stderr tail')
    expect(setTrayStatus).toHaveBeenLastCalledWith('failed')
  })
})

describe('restart', () => {
  it('ignores a superseded child’s exit instead of clobbering the live one', async () => {
    const first = await bootReady()
    trayActions?.restart()
    await vi.waitFor(() => expect(children.length).toBe(2))
    children[1].ready('http://127.0.0.1:6000')
    await settle()

    // The outgoing child finally dies, long after its replacement took over.
    first.exit(143, 'terminated')
    await settle()

    expect(showError).not.toHaveBeenCalled()
    expect(setTrayStatus).toHaveBeenLastCalledWith('running')

    // The decisive part: the live child must still be reachable from the quit path.
    await fake.emit('before-quit', fake.quitEvent())
    await settle()
    expect(children[1].stop).toHaveBeenCalled()
  })

  it('is visible to a quit that arrives inside its stop window', async () => {
    hangStop = true
    const first = await bootReady()

    trayActions?.restart()
    await settle()
    expect(first.stop).toHaveBeenCalled()
    // The old child is stopping and no new one exists yet: the app looks idle.
    const event = fake.quitEvent()
    void fake.emit('before-quit', event)
    await settle()

    expect(event.prevented).toBe(true)

    first.releaseStop()
    await settle()

    // Nothing may be spawned behind the quit's back.
    expect(children.length).toBe(1)
    expect(fake.app.quit).toHaveBeenCalled()
  })
})

describe('before-quit', () => {
  it('reaps a child that has not become ready yet', async () => {
    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))

    await fake.emit('before-quit', fake.quitEvent())
    await settle()

    expect(children[0].stop).toHaveBeenCalled()
    expect(fake.app.quit).toHaveBeenCalled()
  })

  it('does not re-enter once quitting', async () => {
    const child = await bootReady()
    await fake.emit('before-quit', fake.quitEvent())
    await settle()
    const second = fake.quitEvent()
    await fake.emit('before-quit', second)
    expect(second.prevented).toBe(false)
    expect(child.stop).toHaveBeenCalledTimes(1)
  })
})

describe('window lifetime', () => {
  it('hides the window on close and keeps the app running in the tray', async () => {
    await bootReady()
    const event = fake.quitEvent()
    await fake.emitWindow('close', event)
    expect(event.prevented).toBe(true)
    expect(fake.window.hide).toHaveBeenCalled()
    await fake.emit('window-all-closed')
    expect(fake.app.quit).not.toHaveBeenCalled()
  })

  it('lets the window close for real once a quit is under way', async () => {
    await bootReady()
    await fake.emit('before-quit', fake.quitEvent())
    await settle()
    const event = fake.quitEvent()
    await fake.emitWindow('close', event)
    expect(event.prevented).toBe(false)
  })
})

describe('deep links', () => {
  it('applies a cold-start dsh:// link once the window exists', async () => {
    await loadIndex()
    // macOS delivers open-url before whenReady, when there is no window yet.
    await fake.emit('open-url', fake.quitEvent(), 'dsh://open')
    expect(fake.window.show).not.toHaveBeenCalled()

    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].ready()
    await settle()

    expect(fake.window.show).toHaveBeenCalled()
    expect(fake.window.focus).toHaveBeenCalled()
  })

  it('raises the window for a link that arrives while it is up', async () => {
    await bootReady()
    await fake.emit('open-url', fake.quitEvent(), 'dsh://open')
    expect(fake.window.focus).toHaveBeenCalled()
  })
})

describe('hotkey', () => {
  it('reports an accelerator the system refused to bind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.globalShortcut.register.mockReturnValue(false)
    await bootReady()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be registered'))
    warn.mockRestore()
  })
})
