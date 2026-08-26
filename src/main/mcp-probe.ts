import { spawn, type ChildProcess } from 'node:child_process'
import { stopGroup } from './server'

/** What a probe found, or why it could not find it. */
export type ProbeResult = { ok: true; tools: string[] } | { ok: false; message: string }

/** One server to probe: exactly what would be written into `mcp.json`. */
export interface ProbeTarget {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

/** Runs MCP handshakes against candidate servers and owns every child they spawn. */
export interface McpProber {
  /**
   * Start a stdio MCP server, complete the handshake, and list its tools.
   * @param target - the command to run, as `mcp.json` would hold it.
   * @param onLine - receives the server's stderr lines as they arrive, which
   *   is where `npx` writes its download progress.
   * @returns the tool names, or why the server could not be reached.
   */
  probe(target: ProbeTarget, onLine: (line: string) => void): Promise<ProbeResult>
  /**
   * Terminate every probe still running, process group included, and refuse
   * every later `probe` call — a shutdown signal, not a pause.
   * @returns a promise that settles once none is left running.
   */
  stopAll(): Promise<void>
}

/** JSON-RPC id for the handshake, distinct from the tool listing's. */
const INITIALIZE_ID = 1
/** JSON-RPC id for the tool listing. */
const TOOLS_ID = 2

/**
 * The protocol version this probe claims.
 *
 * A server that does not recognize it still answers with its own, and this
 * probe only needs the handshake to complete — it never exercises a
 * version-specific feature.
 */
const PROTOCOL_VERSION = '2025-06-18'

/**
 * Build a prober whose children the quit path can reap.
 *
 * Deliberately has no time bound. The first run of an `npx`-based server
 * downloads its package, which can take minutes on a slow link — and a bound
 * here would reintroduce exactly the failure this exists to avoid, where a
 * server that would have worked is reported as broken because a timer
 * expired. Cancellation is the user's, through `stopAll` at quit or the
 * window's own control.
 *
 * Each child is spawned `detached` so it leads its own process group, and is
 * killed through the same `stopGroup` the harness child uses: a probed
 * server may itself spawn children (a browser, a language server), and
 * killing only the direct child would orphan them.
 * @returns a prober backed by real child processes.
 */
export function createMcpProber(): McpProber {
  const running = new Set<ChildProcess>()
  let stopped = false

  return {
    async probe(target, onLine) {
      if (stopped) return { ok: false, message: 'The app is shutting down.' }

      let child: ChildProcess
      try {
        child = spawn(target.command, target.args, {
          cwd: target.cwd,
          // The probe must see the same environment the harness child would
          // give this server, or a server that works there fails here.
          env: { ...process.env, ...target.env },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
      running.add(child)

      return await new Promise<ProbeResult>((resolve) => {
        let settled = false
        /**
         * Resolve once and reap the process group.
         * @param result - the outcome to report.
         */
        const finish = (result: ProbeResult): void => {
          if (settled) return
          settled = true
          running.delete(child)
          void stopGroup(child)
          resolve(result)
        }

        child.on('error', (error) => {
          // ENOENT here is the common case and the useful one: the command is
          // not on the PATH the app resolved, which is a fixable mistake the
          // user should see named rather than as a silent failure to connect.
          finish({ ok: false, message: `${target.command} could not be started: ${error.message}` })
        })
        child.on('exit', (code) => {
          finish({ ok: false, message: `${target.command} exited (code ${String(code)}) before completing the handshake.` })
        })

        // stderr is progress, not failure: `npx` reports its download there,
        // and many MCP servers log there routinely.
        let errorTail = ''
        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          errorTail = `${errorTail}${text}`.slice(-2000)
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (trimmed !== '') onLine(trimmed)
          }
        })

        /**
         * Send one JSON-RPC message, newline-framed as MCP's stdio transport
         * requires.
         * @param message - the message to send.
         */
        const send = (message: unknown): void => {
          child.stdin?.write(`${JSON.stringify(message)}\n`)
        }

        let buffer = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim() === '') continue
            let message: { id?: unknown; result?: { tools?: { name?: unknown }[] }; error?: { message?: unknown } }
            try {
              message = JSON.parse(line)
            } catch {
              // A server that writes non-JSON to stdout is not speaking MCP
              // there; ignore the line rather than failing the probe, since
              // the handshake may still complete on a later one.
              continue
            }
            if (message.id === INITIALIZE_ID) {
              if (message.error !== undefined) {
                finish({ ok: false, message: `The server refused the handshake: ${String(message.error.message)}` })
                return
              }
              send({ jsonrpc: '2.0', method: 'notifications/initialized' })
              send({ jsonrpc: '2.0', id: TOOLS_ID, method: 'tools/list' })
            }
            if (message.id === TOOLS_ID) {
              if (message.error !== undefined) {
                finish({ ok: false, message: `The server could not list its tools: ${String(message.error.message)}` })
                return
              }
              const tools = (message.result?.tools ?? [])
                .map((tool) => tool.name)
                .filter((name): name is string => typeof name === 'string')
              finish({ ok: true, tools })
              return
            }
          }
        })

        send({
          jsonrpc: '2.0',
          id: INITIALIZE_ID,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'dsh-desktop', version: '0' },
          },
        })
      })
    },

    async stopAll() {
      stopped = true
      await Promise.all([...running].map(async (child) => stopGroup(child)))
      running.clear()
    },
  }
}

/**
 * The tail of a probe's stderr, for a failure the handshake itself could not
 * explain.
 *
 * Exported so the caller can decide how much of it to show; a server that
 * dies during startup usually says why on stderr and nowhere else.
 * @param lines - the lines collected during the probe.
 * @param limit - how many trailing lines to keep.
 * @returns the trailing lines, joined.
 */
export function probeTail(lines: string[], limit = 5): string {
  return lines.slice(-limit).join('\n')
}
