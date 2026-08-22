import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInstallRunner } from './install-process'

/**
 * Tests for the runner that owns every `npm` child a managed install spawns.
 *
 * These drive real processes rather than a fake `spawn`: the property under
 * test is that quitting actually reaps the install — process group included —
 * and a mock can only ever show that a function was called. Each child prints
 * its own pid and its grandchild's, so the test can ask the operating system
 * whether they are gone.
 */

/**
 * A child that reports its pid and its grandchild's, then keeps both alive.
 *
 * The grandchild stands in for the processes `npm` itself spawns: it is not
 * detached, so it inherits the child's process group and survives anything
 * that signals the direct child alone.
 */
const LONG_RUNNING = `
const { spawn } = require('node:child_process')
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
process.stdout.write('parent ' + process.pid + '\\n' + 'child ' + kid.pid + '\\n')
setInterval(() => {}, 1000)
`

/** Pids this file started, killed in `afterEach` so a failing test leaks nothing. */
const started: number[] = []

/**
 * Whether a pid still exists.
 * @param pid - the process to probe.
 * @returns whether signal 0 reaches it.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process, which is what the caller is asking about.
    return false
  }
}

/**
 * Start `LONG_RUNNING` under a runner and wait until both pids are known.
 * @param runner - the runner under test.
 * @param timeoutMs - optional bound to pass through to the run.
 * @returns the settled-later run promise and the two live pids.
 */
async function startLongRunning(
  runner: ReturnType<typeof createInstallRunner>,
  timeoutMs?: number,
): Promise<{ run: Promise<unknown>; pids: number[] }> {
  const pids: number[] = []
  const run = runner.run(process.execPath, ['-e', LONG_RUNNING], {
    timeoutMs,
    onLine: (line) => {
      const match = /^(?:parent|child) (\d+)$/.exec(line.trim())
      if (match !== null) {
        pids.push(Number(match[1]))
        started.push(Number(match[1]))
      }
    },
  })
  // A rejection (the timeout case) must not surface as an unhandled rejection
  // while the test is still waiting for the pids to appear.
  run.catch(() => {})
  await vi.waitFor(() => {
    expect(pids.length).toBe(2)
  })
  return { run, pids }
}

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ESRCH: already gone, which is the expected state after a passing test.
    }
  }
})

describe('stopAll', () => {
  it('kills an in-flight install and its whole process group', async () => {
    const runner = createInstallRunner()
    const { run, pids } = await startLongRunning(runner)
    expect(pids.every(alive)).toBe(true)

    await runner.stopAll()
    await run

    await vi.waitFor(() => {
      expect(pids.filter(alive)).toEqual([])
    })
  })

  it('resolves when nothing is running', async () => {
    await expect(createInstallRunner().stopAll()).resolves.toBeUndefined()
  })

  it('has nothing left to kill once a run has finished on its own', async () => {
    const runner = createInstallRunner()

    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("done\\n")'], {})

    expect(result).toEqual({ code: 0, stdout: 'done\n', stderr: '' })
    await expect(runner.stopAll()).resolves.toBeUndefined()
  })

  it('refuses every run() from then on, so nothing spawned afterward is ever left unreaped', async () => {
    // This is the guard `settings-ipc.ts`'s plugin-install loop relies on: a
    // quit's `stopAll()` must not just kill what is already running, it must
    // make every later `run()` call in the same process a no-op, or a loop
    // unaware that quitting started midway would keep spawning fresh
    // `npm` trees nothing ever reaps again. Proven against a real spawn, not
    // a mock: the process-count assertion below would not move if `run()`
    // silently still spawned and only synchronously "looked" refused.
    const runner = createInstallRunner()
    await runner.stopAll()

    const before = started.length
    await expect(runner.run(process.execPath, ['-e', LONG_RUNNING], {})).rejects.toThrow(
      /was not started; the app is shutting down/,
    )

    // Real proof nothing spawned: give a real child every chance to report
    // its pid (it does so within milliseconds when it actually starts), then
    // confirm none arrived.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(started.length).toBe(before)
  })
})

describe('timeoutMs', () => {
  it('kills a run that outlives its bound and rejects naming the limit', async () => {
    const runner = createInstallRunner()
    const { run, pids } = await startLongRunning(runner, 250)

    await expect(run).rejects.toThrow(/exceeded 250ms and was stopped/)

    await vi.waitFor(() => {
      expect(pids.filter(alive)).toEqual([])
    })
  })

  it('lets a run that finishes inside its bound resolve normally', async () => {
    const runner = createInstallRunner()

    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("quick\\n")'], {
      timeoutMs: 10_000,
    })

    expect(result.code).toBe(0)
  })
})

describe('run', () => {
  it('feeds each output line to onLine and returns the captured streams', async () => {
    const runner = createInstallRunner()
    const lines: string[] = []

    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write("added 455 packages\\nfound 0 vulnerabilities\\n")'],
      { onLine: (line) => lines.push(line) },
    )

    expect(lines).toEqual(['added 455 packages', 'found 0 vulnerabilities'])
    expect(result.code).toBe(0)
  })

  it('reports a non-zero exit with its stderr rather than rejecting', async () => {
    const runner = createInstallRunner()

    const result = await runner.run(process.execPath, ['-e', 'process.stderr.write("npm ERR!"); process.exit(1)'], {})

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'npm ERR!' })
  })

  it('rejects when the binary cannot be spawned at all', async () => {
    const runner = createInstallRunner()

    await expect(runner.run('/nonexistent/npm', [], {})).rejects.toThrow(/failed to spawn \/nonexistent\/npm/)
  })
})
