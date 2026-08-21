import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { dshWebCommand, resolveBinary, startServer, type ServerHandle } from './server'

const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-server.mjs')

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
    )
    expect(spec.command).toBe('/usr/local/bin/pnpm')
    // `dsh web` is a subcommand alias that rejects any parent-level flag, `--patch`
    // included, so the real CLI invocation goes through `--profile web` instead.
    expect(spec.args).toEqual(['dsh', '--profile', 'web', '--patch', '/tmp/desktop.patch.yml', '--no-open'])
    expect(spec.cwd).toBe('/tmp/harness')
  })

  it('runs npx against the published package for an npx source', () => {
    const spec = dshWebCommand(
      {
        harness: { kind: 'npx', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
        notifyPort: 1,
        hotkey: 'x',
        npxPath: '/usr/local/bin/npx',
      },
      '/tmp/desktop.patch.yml',
    )
    expect(spec.command).toBe('/usr/local/bin/npx')
    expect(spec.args).toEqual([
      '-y', '@deepseek-ai/dsh@latest', '--', '--profile', 'web', '--patch', '/tmp/desktop.patch.yml', '--no-open',
    ])
    expect(spec.cwd).toBe('/tmp/ws')
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

  it('names the right binary and config key for npx', () => {
    expect(() => resolveBinary(undefined, 'npx', { PATH: '/usr/bin:/bin' })).toThrow(
      /npx is not on PATH.*"npxPath"/s,
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
