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

/**
 * Listen on loopback for turn-end pings from the harness Stop hook.
 *
 * The port is the configured one rather than OS-assigned because the harness
 * reads its hook config once at load: the `curl` in the Stop hook command is
 * generated with this port baked in (see `runtime-files`) and cannot discover
 * one chosen after the fact.
 * @param port - the configured port; 0 is used by tests for an ephemeral port.
 * @param onTurnEnd - invoked once per POST to `/turn-end`.
 * @returns the listening server.
 */
export function startNotifyListener(port: number, onTurnEnd: () => void): Promise<NotifyServer> {
  return new Promise<NotifyServer>((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/turn-end') {
        request.resume()
        response.writeHead(204).end()
        onTurnEnd()
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
