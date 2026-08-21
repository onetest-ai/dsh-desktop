import { createServer, type Server } from 'node:http'

/** The running notification endpoint. */
export interface NotifyServer {
  port: number
  close(): Promise<void>
}

/**
 * Listen on loopback for turn-end pings from the harness Stop hook.
 *
 * The port is fixed rather than OS-assigned because `hooks.json` is a static
 * file the harness reads at load: the hook command cannot discover a port
 * chosen at runtime.
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
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}
