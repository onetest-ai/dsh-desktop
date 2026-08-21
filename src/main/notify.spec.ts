import { afterEach, describe, expect, it } from 'vitest'
import { startNotifyListener, type NotifyServer } from './notify'

let server: NotifyServer | undefined

afterEach(async () => {
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
})
