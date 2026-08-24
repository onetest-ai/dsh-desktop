import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startNotifyListener, type NotifyServer } from './notify'

let server: NotifyServer | undefined
let socket: Socket | undefined

afterEach(async () => {
  socket?.destroy()
  socket = undefined
  await server?.close()
  server = undefined
})

describe('startNotifyListener', () => {
  it('invokes the callback when the hook posts', async () => {
    let fired = 0
    server = await startNotifyListener(0, () => { fired += 1 })
    const response = await fetch(`http://127.0.0.1:${server.port}/turn-end`, { method: 'POST' })
    expect(response.status).toBe(204)
    expect(fired).toBe(1)
  })

  it('ignores unrelated paths', async () => {
    let fired = 0
    server = await startNotifyListener(0, () => { fired += 1 })
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`, { method: 'POST' })
    expect(response.status).toBe(404)
    expect(fired).toBe(0)
  })

  it('rejects when the port is already taken', async () => {
    server = await startNotifyListener(0, () => {})
    await expect(startNotifyListener(server.port, () => {})).rejects.toThrow(/in use/)
  })

  it('close() resolves even while a client stalls mid-request', async () => {
    // A `Content-Length` request whose body never fully arrives — a client
    // that connects, sends headers, then stalls (a dropped connection, a
    // killed process) — leaves the socket "in use" from Node's own
    // perspective even though the handler already ran and responded: the
    // response is written and `onTurnEnd` fires, but nothing ever signals
    // the request itself as finished. Node's `http.Server.close()` invokes
    // its callback only once every accepted connection has ended, so without
    // `close()`'s own force-close bound this hangs forever instead of
    // resolving within `CLOSE_TIMEOUT_MS`.
    server = await startNotifyListener(0, () => {})
    await new Promise<void>((resolve, reject) => {
      socket = connect(server?.port ?? 0, '127.0.0.1', () => {
        socket?.write('POST /turn-end HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n')
        resolve()
      })
      socket.once('error', reject)
    })
    // Gives the server a moment to actually receive and parse the stalled
    // request before `close()` is called, so the race is against the real
    // condition (an accepted, in-progress request) rather than a socket
    // `close()` might still see as merely pending.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const start = Date.now()
    await server.close()
    expect(Date.now() - start).toBeLessThan(4000)
  })
})
