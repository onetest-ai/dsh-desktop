import { spawn, type ChildProcess } from 'node:child_process'
import { stopGroup } from './server'

/** Working directory, environment, per-line output callback, and time bound for one run. */
export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  onLine?: (line: string) => void
  /** Upper bound on the run; when it elapses the process group is killed and the run rejects. */
  timeoutMs?: number
}

/** A completed run's exit code and captured output. */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs install commands and owns every child they spawn, so quit can reap them. */
export interface InstallRunner {
  /**
   * Run a command to completion, feeding every combined stdout/stderr line to
   * `onLine` as it arrives.
   * @param command - the binary to run.
   * @param args - its arguments.
   * @param options - working directory, environment, per-line callback, and timeout.
   * @returns the completed run's exit code and captured output.
   */
  run(command: string, args: string[], options: RunOptions): Promise<RunResult>
  /**
   * Terminate every run still in flight, process group included.
   * @returns a promise that settles once none of them is left running.
   */
  stopAll(): Promise<void>
}

/**
 * Build a runner whose children the quit path can reap.
 *
 * A managed install runs `npm` for minutes. Spawning it the way an ordinary
 * child is spawned leaves it running — reparented to the init process, still
 * writing into `$DSH_HOME/runtimes` — after Electron exits. Each child is
 * therefore spawned `detached` so it leads its own process group (npm's own
 * children stay in that group), tracked here from spawn until exit, and killed
 * through the same `stopGroup` the harness child uses.
 * @returns a runner backed by real child processes.
 */
export function createInstallRunner(): InstallRunner {
  const running = new Set<ChildProcess>()

  return {
    run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
      return new Promise<RunResult>((resolve, reject) => {
        const proc = spawn(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        running.add(proc)

        let stdout = ''
        let stderr = ''
        let buffer = ''
        let finished = false
        let timer: NodeJS.Timeout | undefined

        const finish = (): boolean => {
          running.delete(proc)
          if (timer !== undefined) clearTimeout(timer)
          if (finished) return false
          finished = true
          return true
        }

        const feed = (chunk: Buffer): void => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) options.onLine?.(line)
        }

        if (options.timeoutMs !== undefined) {
          const limit = options.timeoutMs
          timer = setTimeout(() => {
            // The group is killed before rejecting: without it a hung registry
            // connection would leave npm running for as long as it liked while
            // the caller had already given up on it.
            void stopGroup(proc)
            if (finish()) {
              reject(new Error(`dsh-desktop: ${command} ${args.join(' ')} exceeded ${String(limit)}ms and was stopped.`))
            }
          }, limit)
        }

        proc.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
          feed(chunk)
        })
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
          feed(chunk)
        })
        proc.on('error', (cause) => {
          if (finish()) reject(new Error(`dsh-desktop: failed to spawn ${command}`, { cause }))
        })
        proc.on('close', (code) => {
          if (buffer !== '') options.onLine?.(buffer)
          // A killed run has already rejected; `finish` reports that so the
          // exit that the kill itself produced is not reported as a result.
          if (finish()) resolve({ code: code ?? 1, stdout, stderr })
        })
      })
    },

    async stopAll(): Promise<void> {
      const children = [...running]
      running.clear()
      await Promise.all(children.map((proc) => stopGroup(proc)))
    },
  }
}
