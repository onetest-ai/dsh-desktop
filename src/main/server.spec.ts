import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { dshWebCommand, resolvePnpm, startServer, type ServerHandle } from './server'

const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-server.mjs')

function fakeSpec(mode: string, port = '54321') {
  return {
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: { ...process.env, FAKE_MODE: mode, FAKE_PORT: port },
  }
}

let running: ServerHandle | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

describe('dshWebCommand', () => {
  it('runs dsh web with the patch overlay and no browser handoff', () => {
    const spec = dshWebCommand(
      { harnessRepo: '/tmp/harness', notifyPort: 1, hotkey: 'x', pnpmPath: '/usr/local/bin/pnpm' },
      '/tmp/desktop.patch.yml',
    )
    expect(spec.command).toBe('/usr/local/bin/pnpm')
    expect(spec.args).toEqual(['dsh', 'web', '--no-open', '--patch', '/tmp/desktop.patch.yml'])
    expect(spec.cwd).toBe('/tmp/harness')
  })
})

describe('resolvePnpm', () => {
  it('prefers an explicit pnpmPath', () => {
    const config = { harnessRepo: '/tmp/h', notifyPort: 1, hotkey: 'x', pnpmPath: '/opt/pnpm' }
    expect(resolvePnpm(config, {})).toBe('/opt/pnpm')
  })

  it('falls back to a bare pnpm when PATH looks like a real login environment', () => {
    const config = { harnessRepo: '/tmp/h', notifyPort: 1, hotkey: 'x' }
    expect(resolvePnpm(config, { PATH: '/opt/homebrew/bin:/usr/bin:/bin' })).toBe('pnpm')
  })

  it('throws when PATH carries only system directories', () => {
    const config = { harnessRepo: '/tmp/h', notifyPort: 1, hotkey: 'x' }
    expect(() => resolvePnpm(config, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })).toThrow(
      /pnpm is not on PATH/,
    )
  })
})

describe('startServer', () => {
  it('resolves with the loopback URL from the ready line, ignoring the LAN suffix', async () => {
    running = await startServer({ spec: fakeSpec('ready', '61234'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:61234')
  })

  it('resolves with the full URL when the ready line arrives split across chunks', async () => {
    running = await startServer({ spec: fakeSpec('split', '61235'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:61235')
  })

  it('ignores stdout noise that precedes the ready line', async () => {
    running = await startServer({ spec: fakeSpec('ready'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:54321')
  })

  it('rejects when no ready line arrives before the timeout', async () => {
    await expect(startServer({ spec: fakeSpec('silent'), timeoutMs: 500 })).rejects.toThrow(
      /did not report a URL/,
    )
  })

  it('rejects with the stderr tail when the server exits early', async () => {
    await expect(startServer({ spec: fakeSpec('crash'), timeoutMs: 10_000 })).rejects.toThrow(
      /boom/,
    )
  })
})
