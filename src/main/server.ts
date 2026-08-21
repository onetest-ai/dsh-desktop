import { spawn, type ChildProcess } from 'node:child_process'
import type { DesktopConfig } from './config'

/** A running harness server and the URL its window should load. */
export interface ServerHandle {
  url: string
  stop(): Promise<void>
}

/** Everything needed to launch the server child. */
export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface StartOptions {
  spec: SpawnSpec
  timeoutMs: number
  /** Called only for an exit AFTER the server became ready. */
  onExit?: (code: number | null, stderrTail: string) => void
  /** Receives every stdout line, including lines before readiness. Used for logging and tests. */
  onStdoutLine?: (line: string) => void
}

/** The harness prints this once the webserver is listening. */
const READY_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** How much stderr to keep for failure reporting. */
const STDERR_TAIL_LIMIT = 4000

/** Grace period between SIGTERM and SIGKILL on shutdown. */
const KILL_GRACE_MS = 3000

/**
 * Decide which pnpm binary to spawn.
 *
 * A packaged macOS app launched from Finder inherits a minimal PATH that has
 * no Homebrew or Corepack shim, so a bare `pnpm` fails with ENOENT. An
 * explicit `pnpmPath` always wins; otherwise a bare `pnpm` is used only when
 * PATH carries entries beyond the system defaults.
 * @param config - the desktop settings.
 * @param env - the environment the app was launched with.
 * @returns the command to spawn.
 */
export function resolvePnpm(config: DesktopConfig, env: NodeJS.ProcessEnv): string {
  if (config.pnpmPath !== undefined) return config.pnpmPath
  const path = env.PATH ?? ''
  const systemOnly = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin', ''])
  const hasUserPath = path.split(':').some((entry) => !systemOnly.has(entry))
  if (hasUserPath) return 'pnpm'
  throw new Error(
    'dsh-desktop: pnpm is not on PATH (a Finder launch inherits a minimal PATH). ' +
      'Set "pnpmPath" in config.json to the absolute path from `which pnpm`.',
  )
}

/**
 * Build the spawn specification for `dsh web` against the configured checkout.
 * @param config - the desktop settings.
 * @param patchFile - absolute path to this project's cordis patch overlay.
 * @returns the command, arguments, and working directory.
 */
export function dshWebCommand(config: DesktopConfig, patchFile: string): SpawnSpec {
  return {
    command: resolvePnpm(config, process.env),
    args: ['dsh', 'web', '--no-open', '--patch', patchFile],
    cwd: config.harnessRepo,
  }
}

/**
 * Spawn the harness server and resolve once it reports its URL.
 *
 * The child is detached so it becomes its own process group leader: the
 * harness spawns node-pty grandchildren, and killing only the direct child
 * would orphan them.
 * @param options - spawn specification, readiness timeout, and exit callback.
 * @returns a handle carrying the URL and a group-wide stop.
 */
export function startServer(options: StartOptions): Promise<ServerHandle> {
  const { spec, timeoutMs, onExit } = options

  return new Promise<ServerHandle>((resolve, reject) => {
    const child: ChildProcess = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let ready = false
    let stdoutBuffer = ''
    let stderrTail = ''
    const handle: ServerHandle = {
      url: '',
      stop: () => stopGroup(child),
    }

    const timer = setTimeout(() => {
      if (ready) return
      void stopGroup(child)
      reject(new Error(`dsh-desktop: the harness did not report a URL within ${timeoutMs}ms.\n${stderrTail}`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        options.onStdoutLine?.(line)
        const match = READY_PATTERN.exec(line.trim())
        if (match === null || ready) continue
        ready = true
        clearTimeout(timer)
        handle.url = match[1]
        resolve(handle)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT)
    })

    child.on('error', (cause) => {
      clearTimeout(timer)
      if (!ready) reject(new Error(`dsh-desktop: failed to spawn ${spec.command}`, { cause }))
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (ready) {
        onExit?.(code, stderrTail)
        return
      }
      reject(new Error(`dsh-desktop: the harness exited with code ${String(code)} before starting.\n${stderrTail}`))
    })
  })
}

/**
 * Terminate the child's entire process group, escalating to SIGKILL.
 * @param child - the detached child process.
 */
function stopGroup(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const pid = child.pid
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }

    const finish = (): void => {
      clearTimeout(escalation)
      resolve()
    }
    child.once('exit', finish)

    const escalation = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // ESRCH: the group is already gone, which is the outcome we wanted.
      }
      resolve()
    }, KILL_GRACE_MS)

    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // ESRCH: the group exited between the liveness check and this signal.
      finish()
    }
  })
}
