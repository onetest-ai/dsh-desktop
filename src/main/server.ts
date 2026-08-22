import { spawn, type ChildProcess } from 'node:child_process'
import { delimiter, dirname } from 'node:path'
import type { DesktopConfig } from './config'
import { ConfigurationError } from './configuration-error'
import { spawnFor, type SpawnSpec } from './harness-source'

export type { SpawnSpec } from './harness-source'

/** A running harness server and the URL its window should load. */
export interface ServerHandle {
  url: string
  stop(): Promise<void>
}

export interface StartOptions {
  spec: SpawnSpec
  timeoutMs: number
  /** Called only for an exit AFTER the server became ready. */
  onExit?: (code: number | null, stderrTail: string) => void
  /** Receives every stdout line, including lines before readiness. Used for logging and tests. */
  onStdoutLine?: (line: string) => void
  /** Invoked synchronously once the child exists, before readiness, so a caller quitting mid-boot can still reap it. */
  onSpawned?: (stop: () => Promise<void>) => void
}

/** The harness prints this once the webserver is listening. */
const READY_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** How much stderr to keep for failure reporting. */
const STDERR_TAIL_LIMIT = 4000

/** Grace period between SIGTERM and SIGKILL on shutdown. */
const KILL_GRACE_MS = 3000

/**
 * How long `stopGroup` waits for the exit event after SIGKILL. SIGKILL cannot
 * be caught, so the event is imminent; the bound exists only so the quit path
 * can never hang on a pathological child.
 */
const REAP_TIMEOUT_MS = 1000

/**
 * Decide which binary to spawn for a launcher.
 *
 * A packaged macOS app launched from Finder inherits a minimal PATH that has
 * no Homebrew or Corepack shim, so a bare binary name fails with ENOENT. An
 * explicit configured path always wins; otherwise the bare name is used only
 * when PATH carries entries beyond the system defaults.
 * @param configured - the explicit path from `desktop.json`, if set.
 * @param name - the binary name, used both as the PATH-relative fallback and in the error message.
 * @param env - the environment the app was launched with.
 * @returns the command to spawn.
 */
export function resolveBinary(configured: string | undefined, name: string, env: NodeJS.ProcessEnv): string {
  if (configured !== undefined) return configured
  const path = env.PATH ?? ''
  const systemOnly = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin', ''])
  const hasUserPath = path.split(':').some((entry) => !systemOnly.has(entry))
  if (hasUserPath) return name
  throw new ConfigurationError(
    `dsh-desktop: ${name} is not on PATH (a Finder launch inherits a minimal PATH). ` +
      `Set "${name}Path" in desktop.json to the absolute path from \`which ${name}\`.`,
  )
}

/**
 * Extend the child's `PATH` with a resolved launcher's own directory.
 *
 * Under nvm, Homebrew, Volta, and similar layouts, an installed `pnpm`/`npx`
 * is itself a script with a `#!/usr/bin/env node` (or similar) shebang, and
 * `node` normally sits beside it in the same directory. An explicit
 * `pnpmPath`/`npxPath` fixes *finding* the launcher under a Finder-minimal
 * PATH, but the shebang interpreter lookup happens again, one level down, in
 * the *spawned child's* environment — so without this, a correctly
 * configured absolute path still fails to spawn, just with a different
 * error (`env: node: No such file or directory`) than the one `resolveBinary`
 * guards against.
 *
 * A bare name (no directory component) came from `PATH` already resolving
 * it, so nothing needs adding — this returns `undefined` and the caller
 * spawns with the inherited environment unchanged.
 * @param command - the resolved launcher, as returned by `resolveBinary` (absolute path or bare name).
 * @param env - the app's own environment; never mutated, only read.
 * @returns a copy of `env` with `command`'s directory prepended to `PATH`, or `undefined` for a bare name.
 */
function envWithLauncherDir(command: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  const dir = dirname(command)
  if (dir === '.') return undefined
  return { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ''}` }
}

/**
 * Build the spawn specification for the configured harness source.
 *
 * Each launcher is passed as a thunk rather than a resolved string, so
 * `spawnFor` only resolves the binary the chosen source actually needs — a
 * local source must never fail to start because `npxPath` cannot be
 * resolved, and vice versa.
 *
 * When the resolved launcher is an absolute path, the spawn spec's `PATH`
 * also gets that launcher's own directory prepended (see
 * `envWithLauncherDir`), so the shebang interpreter a script-based `pnpm`/
 * `npx` needs is findable too.
 * @param config - the desktop settings.
 * @param patchFile - absolute path to this project's cordis patch overlay.
 * @returns the command, arguments, and working directory.
 */
export function dshWebCommand(config: DesktopConfig, patchFile: string): SpawnSpec {
  const spec = spawnFor(
    config.harness,
    {
      pnpm: () => resolveBinary(config.pnpmPath, 'pnpm', process.env),
      npx: () => resolveBinary(config.npxPath, 'npx', process.env),
    },
    patchFile,
  )
  // Only the process about to be spawned gets the extended PATH; the app's
  // own process.env is never touched.
  const env = envWithLauncherDir(spec.command, process.env)
  return env === undefined ? spec : { ...spec, env }
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
    options.onSpawned?.(() => stopGroup(child))

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
 * Signal an entire process group, tolerating a group that has already gone.
 * @param pid - the group leader's pid, signalled as `-pid`.
 * @param signal - the signal to deliver.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already gone, which is the outcome the caller wanted.
  }
}

/**
 * Terminate the child's entire process group, escalating to SIGKILL, and
 * resolve only once the direct child has actually exited.
 *
 * Resolving at the signal rather than at the exit would let a caller treat the
 * child as gone while its `'exit'` (and therefore `onExit`) is still pending,
 * so a stop-then-start sequence could see the outgoing child's exit land after
 * its replacement was already running.
 *
 * When the direct child has already exited, the group is still signalled: the
 * harness's node-pty grandchildren stay in that group and nothing else reaps
 * them. SIGKILL is used directly there because no surviving parent remains to
 * coordinate a graceful stop. The residual risk is the usual one for
 * group-wide signals — the pid could in principle have been recycled after the
 * child was reaped — which is why the live path signals before that can happen.
 * @param child - the detached child process.
 * @returns a promise that settles once the child is gone.
 */
function stopGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return Promise.resolve()

  if (child.exitCode !== null || child.signalCode !== null) {
    signalGroup(pid, 'SIGKILL')
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    let escalation: NodeJS.Timeout | undefined
    let reap: NodeJS.Timeout | undefined

    const finish = (): void => {
      clearTimeout(escalation)
      clearTimeout(reap)
      resolve()
    }
    child.once('exit', finish)

    escalation = setTimeout(() => {
      signalGroup(pid, 'SIGKILL')
      reap = setTimeout(finish, REAP_TIMEOUT_MS)
    }, KILL_GRACE_MS)

    signalGroup(pid, 'SIGTERM')
  })
}
