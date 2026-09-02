import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { managedBin, managedDir } from './harness-source'
import { dshWebCommand, resolveBinary, startServer, type ServerHandle } from './server'

const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-server.mjs')
const DSH_HOME = '/tmp/dsh-home'

function fakeSpec(mode: string, port = '54321') {
  return {
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: { ...process.env, FAKE_MODE: mode, FAKE_PORT: port },
  }
}

let running: ServerHandle | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

describe('dshWebCommand', () => {
  it('runs dsh web with the patch overlay and no browser handoff, for a local source', () => {
    const spec = dshWebCommand(
      {
        harness: { kind: 'local', repo: '/tmp/harness' },
        notifyPort: 1,
        hotkey: 'x',
        pnpmPath: '/usr/local/bin/pnpm',
      },
      '/tmp/desktop.patch.yml',
      DSH_HOME,
    )
    expect(spec.command).toBe('/usr/local/bin/pnpm')
    // `dsh web` is a subcommand alias that rejects any parent-level flag, `--patch`
    // included, so the real CLI invocation goes through `--profile web` instead.
    expect(spec.args).toEqual(['dsh', '--profile', 'web', '--patch', '/tmp/desktop.patch.yml', '--no-open'])
    expect(spec.cwd).toBe('/tmp/harness')
    // An absolute pnpmPath is typically a script needing `node` on PATH (see
    // `envWithLauncherDir`); its own directory must be searched first, with
    // the inherited PATH still honoured afterward.
    expect(spec.env?.PATH).toMatch(/^\/usr\/local\/bin:/)
    expect(spec.env?.PATH).toContain(process.env.PATH ?? '')
  })

  it('runs the installed binary directly for a managed source, with the PATH from npmPath', () => {
    const spec = dshWebCommand(
      {
        harness: { kind: 'managed', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
        notifyPort: 1,
        hotkey: 'x',
        npmPath: '/usr/local/bin/npm',
      },
      '/tmp/desktop.patch.yml',
      DSH_HOME,
    )
    expect(spec.command).toBe(managedBin(managedDir(DSH_HOME, '@deepseek-ai/dsh', 'latest')))
    expect(spec.args).toEqual(['--profile', 'web', '--patch', '/tmp/desktop.patch.yml', '--no-open'])
    expect(spec.cwd).toBe('/tmp/ws')
    // The managed binary lives under $DSH_HOME/runtimes, where no `node` was
    // installed; the directory prepended must be npm's own (see
    // `envWithLauncherDir`), not the managed binary's own directory.
    expect(spec.env?.PATH).toMatch(/^\/usr\/local\/bin:/)
    expect(spec.env?.PATH).toContain(process.env.PATH ?? '')
  })

  it('leaves the environment alone for a bare-name launcher resolved from PATH', () => {
    const spec = dshWebCommand(
      {
        harness: { kind: 'local', repo: '/tmp/harness' },
        notifyPort: 1,
        hotkey: 'x',
        // No pnpmPath: resolveBinary falls back to the bare name from PATH,
        // which needs no directory injected.
      },
      '/tmp/desktop.patch.yml',
      DSH_HOME,
    )
    expect(spec.command).toBe('pnpm')
    expect(spec.env).toBeUndefined()
  })

  describe('with a Finder-minimal PATH', () => {
    // A Finder launch inherits only the system directories; see `resolveBinary`.
    const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    let originalPath: string | undefined

    beforeEach(() => {
      originalPath = process.env.PATH
      process.env.PATH = MINIMAL_PATH
    })

    afterEach(() => {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    })

    it('succeeds in local mode when only pnpmPath is set, the exact reported failure', () => {
      // This is the regression case: before the fix, dshWebCommand resolved
      // BOTH launchers eagerly, so the unused resolution threw even though
      // local mode never spawns the other one.
      const spec = dshWebCommand(
        {
          harness: { kind: 'local', repo: '/tmp/harness' },
          notifyPort: 1,
          hotkey: 'x',
          pnpmPath: '/opt/pnpm',
        },
        '/tmp/desktop.patch.yml',
        DSH_HOME,
      )
      expect(spec.command).toBe('/opt/pnpm')
    })

    it('succeeds in managed mode when only npmPath is set, the mirror case', () => {
      // spec.command for a managed source never depends on npmPath at all —
      // only the PATH prepend does — so this also proves that resolution
      // does not eagerly touch pnpmPath.
      const spec = dshWebCommand(
        {
          harness: { kind: 'managed', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
          notifyPort: 1,
          hotkey: 'x',
          npmPath: '/opt/npm',
        },
        '/tmp/desktop.patch.yml',
        DSH_HOME,
      )
      expect(spec.command).toBe(managedBin(managedDir(DSH_HOME, '@deepseek-ai/dsh', 'latest')))
      expect(spec.env?.PATH).toMatch(/^\/opt:/)
    })
  })
})

describe('resolveBinary', () => {
  it('prefers an explicit configured path', () => {
    expect(resolveBinary('/opt/pnpm', 'pnpm', {})).toBe('/opt/pnpm')
  })

  it('falls back to the bare name when PATH looks like a real login environment', () => {
    expect(resolveBinary(undefined, 'pnpm', { PATH: '/opt/homebrew/bin:/usr/bin:/bin' })).toBe('pnpm')
  })

  it('throws when PATH carries only system directories', () => {
    expect(() => resolveBinary(undefined, 'pnpm', { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })).toThrow(
      /pnpm is not on PATH/,
    )
  })

  it('names the right binary and config key for npm', () => {
    expect(() => resolveBinary(undefined, 'npm', { PATH: '/usr/bin:/bin' })).toThrow(
      /npm is not on PATH.*"npmPath"/s,
    )
  })
})

describe('startServer', () => {
  it('resolves with the loopback URL from the ready line, ignoring the LAN suffix', async () => {
    running = await startServer({ spec: fakeSpec('ready', '61234'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:61234')
  })

  it('resolves with the full URL when the ready line arrives split across chunks', async () => {
    running = await startServer({ spec: fakeSpec('split', '61235'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:61235')
  })

  it('keeps the ?token= query the harness appends, still dropping the LAN suffix', async () => {
    running = await startServer({ spec: fakeSpec('token', '61236'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:61236/?token=aB3-_xYz')
  })

  it('ignores stdout noise that precedes the ready line', async () => {
    running = await startServer({ spec: fakeSpec('ready'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:54321')
  })

  it('rejects when no ready line arrives before the timeout', async () => {
    await expect(startServer({ spec: fakeSpec('silent'), timeoutMs: 500 })).rejects.toThrow(
      /did not report a URL/,
    )
  })

  it('rejects with the stderr tail when the server exits early', async () => {
    await expect(startServer({ spec: fakeSpec('crash'), timeoutMs: 10_000 })).rejects.toThrow(
      /boom/,
    )
  })
})

/** Whether a pid is still alive. Signal 0 performs the existence check only. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH means no such process, which is exactly what the caller is asking about.
    return false
  }
}

describe('stop', () => {
  it('kills grandchildren, not just the direct child', async () => {
    let grandchildPid = 0

    const handle = await startServer({
      spec: fakeSpec('grandchild'),
      timeoutMs: 10_000,
      onStdoutLine: (line) => {
        const match = /^grandchild: (\d+)$/.exec(line.trim())
        if (match !== null) grandchildPid = Number(match[1])
      },
    })
    running = handle

    expect(grandchildPid).toBeGreaterThan(0)
    expect(isAlive(grandchildPid)).toBe(true)

    await handle.stop()
    await new Promise((r) => setTimeout(r, 1000))

    expect(isAlive(grandchildPid)).toBe(false)
  })

  it('onSpawned fires before readiness resolves, and its stop reaps the grandchild', async () => {
    let grandchildPid = 0
    let earlyStop: (() => Promise<void>) | undefined

    const startPromise = startServer({
      spec: fakeSpec('grandchild'),
      timeoutMs: 10_000,
      onSpawned: (stop) => {
        earlyStop = stop
      },
      onStdoutLine: (line) => {
        const match = /^grandchild: (\d+)$/.exec(line.trim())
        if (match !== null) grandchildPid = Number(match[1])
      },
    })

    // The child's readiness line can only arrive through the stdout pipe,
    // which needs at least one async tick after spawn(). So if onSpawned has
    // already fired by this synchronous point, it necessarily fired before
    // startPromise can possibly resolve.
    expect(earlyStop).toBeDefined()

    const handle = await startPromise
    running = handle

    expect(grandchildPid).toBeGreaterThan(0)
    expect(isAlive(grandchildPid)).toBe(true)

    await earlyStop?.()
    running = undefined
    await new Promise((r) => setTimeout(r, 1000))

    expect(isAlive(grandchildPid)).toBe(false)
  })

  it('resolves only after the child is really gone, even when SIGTERM is ignored', async () => {
    const exits: number[] = []
    const handle = await startServer({
      spec: fakeSpec('stubborn'),
      timeoutMs: 10_000,
      onExit: (code) => exits.push(code ?? -1),
    })
    running = handle

    await handle.stop()
    running = undefined

    // A stop that resolved at the SIGKILL rather than at the exit would let this
    // child's onExit land later, on top of whatever replaced it.
    expect(exits.length).toBe(1)
  })

  it('reaps grandchildren even when the direct child has already exited', async () => {
    let grandchildPid = 0
    const exited = { done: false }
    const handle = await startServer({
      spec: fakeSpec('exiting'),
      timeoutMs: 10_000,
      onExit: () => {
        exited.done = true
      },
      onStdoutLine: (line) => {
        const match = /^grandchild: (\d+)$/.exec(line.trim())
        if (match !== null) grandchildPid = Number(match[1])
      },
    })
    running = handle

    while (!exited.done) await new Promise((r) => setTimeout(r, 50))
    expect(isAlive(grandchildPid)).toBe(true)

    await handle.stop()
    running = undefined
    await new Promise((r) => setTimeout(r, 500))

    expect(isAlive(grandchildPid)).toBe(false)
  })

  it('is safe to call twice', async () => {
    const handle = await startServer({ spec: fakeSpec('ready'), timeoutMs: 10_000 })
    running = handle
    await handle.stop()
    await expect(handle.stop()).resolves.toBeUndefined()
  })

  it('reports an exit through onExit once the server was ready', async () => {
    const exits: Array<{ code: number | null; tail: string }> = []
    const handle = await startServer({
      spec: fakeSpec('ready'),
      timeoutMs: 10_000,
      onExit: (code, tail) => exits.push({ code, tail }),
    })
    running = handle
    await handle.stop()
    await new Promise((r) => setTimeout(r, 500))
    expect(exits.length).toBe(1)
  })
})

describe('dshWebCommand PATH composition', () => {
  const CONFIG = { harness: { kind: 'local' as const, repo: '/tmp/h' }, notifyPort: 1, hotkey: 'X' }

  /** The PATH entries the child would be spawned with. */
  function pathEntries(spec: { env?: NodeJS.ProcessEnv }): string[] {
    return (spec.env?.PATH ?? '').split(':')
  }

  it('puts the resolved shell PATH ahead of the inherited one', () => {
    const spec = dshWebCommand(CONFIG, '/tmp/p.yml', '/tmp/home', {}, '/opt/homebrew/bin')
    expect(pathEntries(spec)).toContain('/opt/homebrew/bin')
  })

  it('puts an explicit extraPath ahead of the resolved one, since it is the override', () => {
    const spec = dshWebCommand(
      { ...CONFIG, extraPath: '/my/override' },
      '/tmp/p.yml',
      '/tmp/home',
      {},
      '/opt/homebrew/bin',
    )
    const entries = pathEntries(spec)
    expect(entries.indexOf('/my/override')).toBeLessThan(entries.indexOf('/opt/homebrew/bin'))
  })

  it('changes nothing when neither is set, so today’s behaviour is preserved', () => {
    // Asserted against the untouched shape rather than against another call
    // down the same path: comparing two composed results hides a composition
    // that alters the PATH for everyone equally, which is exactly the bug
    // this test failed to catch the first time it was written.
    const spec = dshWebCommand(CONFIG, '/tmp/p.yml', '/tmp/home', {}, undefined)
    expect(spec.env).toBeUndefined()
  })

  it('does not duplicate an entry the inherited PATH already had', () => {
    const spec = dshWebCommand(CONFIG, '/tmp/p.yml', '/tmp/home', {}, '/usr/bin')
    expect(pathEntries(spec).filter((entry) => entry === '/usr/bin')).toHaveLength(1)
  })
})
