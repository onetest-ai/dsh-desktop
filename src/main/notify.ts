import { createServer, type IncomingMessage, type Server } from 'node:http'

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

/**
 * One dispatch from the listener: a bare hook ping carries only its `kind`;
 * `/pet/event` additionally carries the pet state and templated bubble text
 * the harness hook script computed, when its body parsed as such.
 */
export interface HookEvent {
  kind: HookKind | 'event'
  state?: string
  text?: string
}

/** Maps each bare-ping route this listener answers to the `HookKind` it dispatches. */
const ROUTES: Record<string, HookKind> = {
  '/turn-end': 'turn-end',
  '/hook/prompt': 'prompt',
  '/hook/tool': 'tool',
  '/hook/notify': 'notify',
}

/** Upper bound on a `/pet/event` request body; anything beyond is discarded unread. */
const MAX_EVENT_BODY_BYTES = 64 * 1024

/**
 * Read a bounded, best-effort JSON body off `request` and resolve the
 * `{state, text}` it carries. Never rejects: a body over the cap, one that
 * never parses as JSON, or one whose shape doesn't match just yields `{}` —
 * this is a loopback ping from our own hook script, not a channel worth
 * failing loudly over.
 */
function readEventBody(request: IncomingMessage): Promise<{ state?: string; text?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let overflowed = false
    const done = (result: { state?: string; text?: string }): void => {
      request.removeAllListeners('data')
      request.removeAllListeners('end')
      request.removeAllListeners('error')
      resolve(result)
    }
    request.on('data', (chunk: Buffer) => {
      if (overflowed) return
      bytes += chunk.length
      if (bytes > MAX_EVENT_BODY_BYTES) {
        // Over the cap: stop buffering and ignore the rest of the body, but
        // keep draining it (rather than `destroy()`ing the request) so the
        // socket stays intact for the 204 this same connection still owes —
        // destroying it here would tear down the response along with it.
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (overflowed) {
        done({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const state = typeof parsed === 'object' && parsed !== null && 'state' in parsed ? (parsed as { state: unknown }).state : undefined
        const text = typeof parsed === 'object' && parsed !== null && 'text' in parsed ? (parsed as { text: unknown }).text : undefined
        done({
          state: typeof state === 'string' ? state : undefined,
          text: typeof text === 'string' ? text : undefined,
        })
      } catch {
        done({})
      }
    })
    request.on('error', () => done({}))
  })
}

/**
 * Read a bounded, best-effort JSON body off `request` and resolve the string
 * `path` it carries, or undefined when the body is oversized, unparseable, or
 * carries no string `path`. Never rejects — the same forgiving contract as
 * {@link readEventBody}, since this too is a loopback POST from a plugin this
 * app itself shipped.
 */
function readOpenPath(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let overflowed = false
    const done = (result: string | undefined): void => {
      request.removeAllListeners('data')
      request.removeAllListeners('end')
      request.removeAllListeners('error')
      resolve(result)
    }
    request.on('data', (chunk: Buffer) => {
      if (overflowed) return
      bytes += chunk.length
      if (bytes > MAX_EVENT_BODY_BYTES) {
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (overflowed) {
        done(undefined)
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const path = typeof parsed === 'object' && parsed !== null && 'path' in parsed ? (parsed as { path: unknown }).path : undefined
        done(typeof path === 'string' && path.length > 0 ? path : undefined)
      } catch {
        done(undefined)
      }
    })
    request.on('error', () => done(undefined))
  })
}

/**
 * Listen on loopback for hook pings from the harness: `/turn-end` (the Stop
 * hook), `/hook/prompt` (a submitted prompt), `/hook/tool` (a tool call),
 * `/hook/notify` (a harness notification), and `/pet/event` (the pet hook
 * script's own POST, carrying `{state, text}` — the animation state and the
 * already-templated bubble line to show).
 *
 * It also answers `/open`: the desktop-pane plugin POSTs `{path}` here to hand
 * a file the harness would otherwise open natively (`open <path>`, which sends
 * an `.html` to the system browser) to this app instead. `onOpen` decides —
 * it returns whether a pane took the file — and the reply is `200` when it did
 * and `204` when it did not, which is the plugin's signal to fall back to the
 * native opener. Unlike the fire-and-forget hook pings, this one awaits its
 * handler because the plugin waits on the answer.
 *
 * The port is the configured one rather than OS-assigned because the harness
 * reads its hook config once at load: the `curl` in each hook command is
 * generated with this port baked in (see `runtime-files`) and cannot discover
 * one chosen after the fact.
 * @param port - the configured port; 0 is used by tests for an ephemeral port.
 * @param onHook - invoked once per POST to a matched route, with the event it matched.
 * @param onOpen - invoked for a `/open` POST carrying a path; resolves whether a
 *   pane took the file. Omitted (or a body carrying no path) answers `204`.
 * @returns the listening server.
 */
export function startNotifyListener(
  port: number,
  onHook: (event: HookEvent) => void,
  onOpen?: (path: string) => Promise<boolean>,
): Promise<NotifyServer> {
  return new Promise<NotifyServer>((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/open') {
        readOpenPath(request)
          .then((path) => {
            if (onOpen === undefined || path === undefined) {
              response.writeHead(204).end()
              return
            }
            onOpen(path)
              .then((handled) => response.writeHead(handled ? 200 : 204).end())
              .catch(() => response.writeHead(204).end())
          })
          .catch(() => response.writeHead(204).end())
        return
      }
      if (request.method === 'POST' && request.url === '/pet/event') {
        readEventBody(request)
          .then(({ state, text }) => {
            // Write and end the reply before touching `onHook`: a caller-supplied
            // hook that throws must never turn into a second `writeHead` on this
            // same response (ERR_HTTP_HEADERS_SENT) — the 204 is this request's
            // whole contract, and it is satisfied before anything else can fail.
            response.writeHead(204).end()
            try {
              onHook({ kind: 'event', state, text })
            } catch {
              // onHook must never break the reply; the reply is already sent.
            }
          })
          .catch(() => {
            // readEventBody never rejects, but keep this belt-and-braces so a
            // malformed request can never leave the connection hanging.
            response.writeHead(204).end()
            try {
              onHook({ kind: 'event' })
            } catch {
              // onHook must never break the reply; the reply is already sent.
            }
          })
        return
      }
      const kind = request.method === 'POST' && request.url !== undefined ? ROUTES[request.url] : undefined
      if (kind !== undefined) {
        request.resume()
        response.writeHead(204).end()
        onHook({ kind })
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
