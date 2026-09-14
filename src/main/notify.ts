import { createServer, type Server } from 'node:http'

/** The running notification endpoint. */
export interface NotifyServer {
  port: number
  close(): Promise<void>
}

/**
 * Upper bound on `close()`'s graceful wait before forcing every remaining
 * connection shut.
 *
 * Node's `http.Server.close()` invokes its callback only once every
 * connection it accepted has ended — including one accepted but never
 * completing a request (a stalled or malformed client), which otherwise
 * keeps the callback from ever firing at all. `applySettings` awaits this
 * `close()` before rebinding to a new port, so an unbounded wait here would
 * hold a settings save's install-and-apply job open indefinitely — the same
 * failure mode `startServer`'s own readiness timeout exists to prevent for
 * the harness child. The bound is short because the normal case (no
 * lingering connection) already resolves within a tick.
 */
const CLOSE_TIMEOUT_MS = 3000

/** The harness hook a loopback ping reports; a later task maps each to a pet animation state. */
export type HookKind = 'turn-end' | 'prompt' | 'tool' | 'notify'

/** Maps each route this listener answers to the `HookKind` it dispatches. */
const ROUTES: Record<string, HookKind> = {
  '/turn-end': 'turn-end',
  '/hook/prompt': 'prompt',
  '/hook/tool': 'tool',
  '/hook/notify': 'notify',
}

/**
 * Listen on loopback for hook pings from the harness: `/turn-end` (the Stop
 * hook), `/hook/prompt` (a submitted prompt), `/hook/tool` (a tool call), and
 * `/hook/notify` (a harness notification).
 *
 * The port is the configured one rather than OS-assigned because the harness
 * reads its hook config once at load: the `curl` in each hook command is
 * generated with this port baked in (see `runtime-files`) and cannot discover
 * one chosen after the fact.
 * @param port - the configured port; 0 is used by tests for an ephemeral port.
 * @param onHook - invoked once per POST to a matched route, with the kind it matched.
 * @returns the listening server.
 */
export function startNotifyListener(port: number, onHook: (kind: HookKind) => void): Promise<NotifyServer> {
  return new Promise<NotifyServer>((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      const kind = request.method === 'POST' && request.url !== undefined ? ROUTES[request.url] : undefined
      if (kind !== undefined) {
        request.resume()
        response.writeHead(204).end()
        onHook(kind)
        return
      }
      request.resume()
      response.writeHead(404).end()
    })

    server.once('error', (cause: NodeJS.ErrnoException) => {
      reject(
        cause.code === 'EADDRINUSE'
          ? new Error(`dsh-desktop: notification port ${String(port)} is already in use.`)
          : cause,
      )
    })

    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : port,
        close: () =>
          new Promise<void>((done) => {
            let settled = false
            const finish = (): void => {
              if (settled) return
              settled = true
              clearTimeout(forceTimer)
              done()
            }
            server.close(finish)
            const forceTimer = setTimeout(() => {
              // Graceful close hasn't finished within the bound — force every
              // remaining connection (including one stuck mid-request) shut;
              // `server.close`'s own callback still fires once that completes.
              server.closeAllConnections()
            }, CLOSE_TIMEOUT_MS)
          }),
      })
    })
  })
}

/**
 * Whether `port` can currently be bound on loopback.
 * @param port - the port to test.
 * @returns true when a listener could bind it right now.
 */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}
