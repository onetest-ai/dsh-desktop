import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startNotifyListener, type HookEvent, type NotifyServer } from './notify'

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
    const seen: HookEvent[] = []
    server = await startNotifyListener(0, (event) => { seen.push(event) })
    const response = await fetch(`http://127.0.0.1:${server.port}/turn-end`, { method: 'POST' })
    expect(response.status).toBe(204)
    expect(seen).toEqual([{ kind: 'turn-end' }])
  })

  it('ignores unrelated paths', async () => {
    const seen: HookEvent[] = []
    server = await startNotifyListener(0, (event) => { seen.push(event) })
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`, { method: 'POST' })
    expect(response.status).toBe(404)
    expect(seen).toEqual([])
  })

  it('dispatches each hook route to onHook', async () => {
    const seen: HookEvent[] = []
    server = await startNotifyListener(0, (event) => seen.push(event))
    const post = (path: string) =>
      fetch(`http://127.0.0.1:${server?.port}${path}`, { method: 'POST' }).then((r) => r.status)
    expect(await post('/turn-end')).toBe(204)
    expect(await post('/hook/prompt')).toBe(204)
    expect(await post('/hook/tool')).toBe(204)
    expect(await post('/hook/notify')).toBe(204)
    expect(await post('/nope')).toBe(404)
    await server.close()
    expect(seen).toEqual([{ kind: 'turn-end' }, { kind: 'prompt' }, { kind: 'tool' }, { kind: 'notify' }])
  })

  it('dispatches /pet/event with the parsed state and text', async () => {
    const seen: HookEvent[] = []
    server = await startNotifyListener(0, (event) => seen.push(event))
    const response = await fetch(`http://127.0.0.1:${server.port}/pet/event`, {
      method: 'POST',
      body: JSON.stringify({ state: 'running', text: 'Reading x' }),
    })
    expect(response.status).toBe(204)
    expect(seen).toEqual([{ kind: 'event', state: 'running', text: 'Reading x' }])
  })

  it('replies 204 without throwing for a garbage /pet/event body', async () => {
    const seen: HookEvent[] = []
    server = await startNotifyListener(0, (event) => seen.push(event))
    const response = await fetch(`http://127.0.0.1:${server.port}/pet/event`, {
      method: 'POST',
      body: 'not json{',
    })
    expect(response.status).toBe(204)
    expect(seen).toEqual([{ kind: 'event', state: undefined, text: undefined }])
  })

  it('replies 204 without throwing for an oversized /pet/event body', async () => {
    const seen: HookEvent[] = []
    server = await startNotifyListener(0, (event) => seen.push(event))
    const oversized = JSON.stringify({ state: 'running', text: 'x'.repeat(70 * 1024) })
    const response = await fetch(`http://127.0.0.1:${server.port}/pet/event`, {
      method: 'POST',
      body: oversized,
    })
    expect(response.status).toBe(204)
    expect(seen).toEqual([{ kind: 'event' }])
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
    // response is written and `onHook` fires, but nothing ever signals
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
