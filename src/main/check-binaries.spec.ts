import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { checkBinaries, checkBinary, type SpawnFn } from './check-binaries'

/** A minimal fake `ChildProcess`: real `stdout`/`stderr` emitters, a spyable `kill`. */
interface FakeChild {
  child: ChildProcess
  emitStdout(chunk: string): void
  emitStderr(chunk: string): void
  exit(code: number | null): void
  error(cause: Error): void
  killSignals: string[]
}

function fakeChild(): FakeChild {
  const emitter = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const killSignals: string[] = []
  Object.assign(emitter, {
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals) => {
      killSignals.push(signal ?? 'SIGTERM')
      return true
    },
  })
  return {
    child: emitter as unknown as ChildProcess,
    emitStdout: (chunk) => stdout.emit('data', Buffer.from(chunk)),
    emitStderr: (chunk) => stderr.emit('data', Buffer.from(chunk)),
    exit: (code) => emitter.emit('exit', code),
    error: (cause) => emitter.emit('error', cause),
    killSignals,
  }
}

describe('checkBinary', () => {
  it('reports success with the trimmed version the binary printed', async () => {
    const fake = fakeChild()
    const spawnFn: SpawnFn = vi.fn(() => fake.child) as unknown as SpawnFn
    const promise = checkBinary('/opt/pnpm', 'pnpm', {}, 5000, spawnFn)
    fake.emitStdout('9.1.0\n')
    fake.exit(0)
    await expect(promise).resolves.toEqual({ ok: true, version: '9.1.0' })
    // dirname('/opt/pnpm') is '/opt': envWithLauncherDir prepends it to PATH,
    // the same way dshWebCommand spawns the real child.
    expect(spawnFn).toHaveBeenCalledWith('/opt/pnpm', ['--version'], expect.objectContaining({ env: { PATH: '/opt:' } }))
  })

  it('reports the real stderr on a non-zero exit, not a generic message', async () => {
    const fake = fakeChild()
    const spawnFn: SpawnFn = vi.fn(() => fake.child) as unknown as SpawnFn
    const promise = checkBinary('/opt/pnpm', 'pnpm', {}, 5000, spawnFn)
    fake.emitStderr('pnpm: bad option --version\n')
    fake.exit(1)
    await expect(promise).resolves.toEqual({ ok: false, error: 'pnpm: bad option --version' })
  })

  it('surfaces a spawn error verbatim', async () => {
    const fake = fakeChild()
    const spawnFn: SpawnFn = vi.fn(() => fake.child) as unknown as SpawnFn
    const promise = checkBinary('/opt/pnpm', 'pnpm', {}, 5000, spawnFn)
    fake.error(new Error('spawn /opt/pnpm ENOENT'))
    await expect(promise).resolves.toEqual({ ok: false, error: 'spawn /opt/pnpm ENOENT' })
  })

  it("surfaces resolveBinary's own refusal when PATH is system-only and no path is configured", async () => {
    const spawnFn: SpawnFn = vi.fn() as unknown as SpawnFn
    const result = await checkBinary(undefined, 'pnpm', { PATH: '/usr/bin:/bin' }, 5000, spawnFn)
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('a Finder launch inherits a minimal PATH'),
    })
    expect(spawnFn).not.toHaveBeenCalled()
  })

  it('resolves an empty field from PATH, spawning the bare name rather than skipping the check', async () => {
    const fake = fakeChild()
    const spawnFn: SpawnFn = vi.fn(() => fake.child) as unknown as SpawnFn
    const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin' }
    const promise = checkBinary(undefined, 'pnpm', env, 5000, spawnFn)
    fake.emitStdout('8.0.0')
    fake.exit(0)
    await expect(promise).resolves.toEqual({ ok: true, version: '8.0.0' })
    // Bare name: PATH lookup happens in the spawned child, exactly like the real launch.
    expect(spawnFn).toHaveBeenCalledWith('pnpm', ['--version'], expect.objectContaining({ env }))
  })

  it('extends the child PATH with an absolute launcher\'s own directory, the same way dshWebCommand spawns it', async () => {
    const fake = fakeChild()
    const spawnFn: SpawnFn = vi.fn(() => fake.child) as unknown as SpawnFn
    const promise = checkBinary('/opt/pnpm-dir/pnpm', 'pnpm', { PATH: '/usr/bin' }, 5000, spawnFn)
    fake.exit(0)
    await promise
    const [, , options] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(options.env.PATH).toMatch(/^\/opt\/pnpm-dir:/)
    expect(options.env.PATH).toContain('/usr/bin')
  })

  it('hits the timeout and kills the child rather than hanging the caller', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeChild()
      const spawnFn: SpawnFn = vi.fn(() => fake.child) as unknown as SpawnFn
      const promise = checkBinary('/opt/pnpm', 'pnpm', {}, 1000, spawnFn)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(promise).resolves.toEqual({
        ok: false,
        error: 'pnpm --version did not respond within 1000ms.',
      })
      expect(fake.killSignals).toEqual(['SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('checkBinaries', () => {
  it('reports one success and one real failure independently', async () => {
    const pnpmChild = fakeChild()
    const npmChild = fakeChild()
    const spawnFn: SpawnFn = vi.fn((command: string) =>
      command === '/opt/pnpm' ? pnpmChild.child : npmChild.child,
    ) as unknown as SpawnFn

    const promise = checkBinaries('/opt/pnpm', '/opt/npm', {}, 5000, spawnFn)
    pnpmChild.emitStdout('9.1.0')
    pnpmChild.exit(0)
    npmChild.emitStderr('npm: not a valid binary')
    npmChild.exit(1)

    await expect(promise).resolves.toEqual({
      pnpm: { ok: true, version: '9.1.0' },
      npm: { ok: false, error: 'npm: not a valid binary' },
    })
  })

  it('treats a blank field as PATH resolution for each binary independently', async () => {
    const pnpmChild = fakeChild()
    const npmChild = fakeChild()
    const spawnFn: SpawnFn = vi.fn((command: string) => (command === 'pnpm' ? pnpmChild.child : npmChild.child)) as unknown as SpawnFn
    const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin' }

    const promise = checkBinaries('', '  ', env, 5000, spawnFn)
    pnpmChild.exit(0)
    npmChild.exit(0)
    await promise

    expect(spawnFn).toHaveBeenCalledWith('pnpm', ['--version'], expect.objectContaining({ env }))
    expect(spawnFn).toHaveBeenCalledWith('npm', ['--version'], expect.objectContaining({ env }))
  })
})

// Non-vacuity target for the shared-environment claim below: a real spawn,
// through the real `envWithLauncherDir`/`resolveBinary` pair, over an actual
// shebang script and a same-directory `node`. See docs/notes/check-binaries.md
// for the manual before/after run this test is designed to fail without the
// fix (reverting `checkBinary`'s `childEnv` to a bare `env` makes it fail).
describe('checkBinary against a real shebang launcher', () => {
  let dir: string
  let originalPath: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-checkbin-'))
    writeFileSync(join(dir, 'fake-pnpm'), '#!/usr/bin/env node\nconsole.log("9.1.0")\n')
    chmodSync(join(dir, 'fake-pnpm'), 0o755)
    // `node` lives beside `fake-pnpm`, exactly like a real pnpm install: the
    // shebang's own `env node` lookup only succeeds once envWithLauncherDir
    // has prepended this directory to the child's PATH.
    symlinkSync(process.execPath, join(dir, 'node'))
    originalPath = process.env.PATH
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  })

  it('runs an absolute shebang launcher whose interpreter is not on the app-inherited PATH', async () => {
    // A Finder-minimal PATH: neither `dir` nor any other place `node` might
    // live is on it, so this only succeeds through envWithLauncherDir's own
    // prepend of `dir` (fake-pnpm's directory) ahead of it.
    const env = { PATH: '/usr/bin:/bin' }
    const result = await checkBinary(join(dir, 'fake-pnpm'), 'pnpm', env, 10_000)
    expect(result).toEqual({ ok: true, version: '9.1.0' })
  })
})
