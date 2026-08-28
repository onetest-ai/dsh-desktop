import { describe, expect, it, vi } from 'vitest'
import { HIGH_WATERMARK_CHARS } from './pty-flow'
import { runPtyHost, type HostEvent, type HostRequest } from './pty-host'

/** A stand-in pty that records what was done to it. */
function fakePty() {
  const listeners: { data?: (data: string) => void; exit?: (event: { exitCode: number; signal?: number }) => void } = {}
  return {
    written: [] as string[],
    resized: [] as [number, number][],
    killed: 0,
    paused: 0,
    resumed: 0,
    write(data: string) { this.written.push(data) },
    resize(cols: number, rows: number) { this.resized.push([cols, rows]) },
    kill() { this.killed += 1 },
    pause() { this.paused += 1 },
    resume() { this.resumed += 1 },
    onData(listener: (data: string) => void) { listeners.data = listener },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) { listeners.exit = listener },
    emitData(data: string) { listeners.data?.(data) },
    emitExit(exitCode: number, signal?: number) { listeners.exit?.({ exitCode, signal }) },
  }
}

/**
 * A host over a fake channel and a fake pty.
 * @param spawn - overrides how the pty is produced, to fail on demand.
 * @returns the pieces a test drives and inspects.
 */
function host(spawn?: () => never) {
  const events: HostEvent[] = []
  let deliver: (request: HostRequest) => void = () => {}
  const pty = fakePty()
  const spawned: unknown[] = []
  const dispose = runPtyHost(
    { onRequest: (listener) => { deliver = listener }, send: (event) => events.push(event) },
    () => ({
      spawn: (file: string, args: string[], options: unknown) => {
        spawned.push({ file, args, options })
        if (spawn !== undefined) spawn()
        return pty as never
      },
    }),
  )
  const START: HostRequest = {
    kind: 'start', id: 1, shell: '/bin/zsh', args: ['-i'], cwd: '/work', cols: 80, rows: 24, env: { TERM: 'xterm-256color' },
  }
  return { events, pty, spawned, dispose, send: (request: HostRequest) => deliver(request), START }
}

describe('runPtyHost', () => {
  it('spawns the shell it was told to, where it was told to', () => {
    const { send, START, spawned } = host()
    send(START)
    expect(spawned[0]).toMatchObject({
      file: '/bin/zsh',
      args: ['-i'],
      options: { cwd: '/work', cols: 80, rows: 24, name: 'xterm-256color' },
    })
  })

  it('forwards output, input, and resizes', () => {
    const { send, START, pty, events } = host()
    send(START)
    pty.emitData('hello')
    expect(events).toContainEqual({ kind: 'data', id: 1, data: 'hello' })
    send({ kind: 'input', id: 1, data: 'ls\r' })
    expect(pty.written).toEqual(['ls\r'])
    send({ kind: 'resize', id: 1, cols: 100, rows: 30 })
    expect(pty.resized).toEqual([[100, 30]])
  })

  it('reports an exit with its code', () => {
    const { send, START, pty, events } = host()
    send(START)
    pty.emitExit(130, 2)
    expect(events).toContainEqual({ kind: 'exit', id: 1, code: 130, signal: 2 })
  })

  // reason: the shell may be gone, not executable, or the directory deleted.
  // The host has to stay up, or the next terminal has nothing to talk to.
  it('reports a shell that would not start, and survives it', () => {
    const { send, START, events } = host(() => { throw new Error('posix_spawnp failed.') })
    send(START)
    expect(events).toEqual([{ kind: 'failed', id: 1, reason: 'posix_spawnp failed.' }])
    expect(() => send({ kind: 'input', id: 1, data: 'x' })).not.toThrow()
  })

  describe('flow control', () => {
    it('pauses the pty once too much is unacknowledged, and resumes on ack', () => {
      const { send, START, pty } = host()
      send(START)
      pty.emitData('x'.repeat(HIGH_WATERMARK_CHARS))
      expect(pty.paused).toBe(1)
      send({ kind: 'ack', id: 1, chars: HIGH_WATERMARK_CHARS })
      expect(pty.resumed).toBe(1)
    })

    it('leaves an ordinary amount of output alone', () => {
      const { send, START, pty } = host()
      send(START)
      pty.emitData('x'.repeat(1000))
      expect(pty.paused).toBe(0)
    })
  })

  // reason: a shell killed on the way out would otherwise report its exit as
  // well, and main would act on a session it had already forgotten.
  it('reports nothing more after a kill', () => {
    const { send, START, pty, events } = host()
    send(START)
    const before = events.length
    send({ kind: 'kill', id: 1 })
    expect(pty.killed).toBe(1)
    pty.emitExit(0)
    expect(events.length).toBe(before)
  })

  it('ignores requests for a session it does not have', () => {
    const { send, pty } = host()
    expect(() => send({ kind: 'input', id: 99, data: 'x' })).not.toThrow()
    expect(pty.written).toEqual([])
  })

  it('starts a given id once', () => {
    const { send, START, spawned } = host()
    send(START)
    send(START)
    expect(spawned).toHaveLength(1)
  })

  it('kills every shell when the host goes down', () => {
    const { send, START, pty, dispose } = host()
    send(START)
    dispose()
    expect(pty.killed).toBe(1)
  })

  // reason: node-pty is loaded when a terminal is first opened, not at
  // startup, so an app nobody opens a terminal in never loads the native
  // binary at all.
  it('does not load node-pty until a terminal is started', () => {
    const load = vi.fn(() => ({ spawn: () => fakePty() as never }))
    runPtyHost({ onRequest: () => {}, send: () => {} }, load)
    expect(load).not.toHaveBeenCalled()
  })
})
