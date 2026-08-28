import { describe, expect, it } from 'vitest'
import type { HostEvent, HostRequest } from './pty-host'
import { Terminals, type Host } from './terminal'

/**
 * A manager over a fake host, with the levers a test needs.
 * @returns the manager and what it did.
 */
function manager() {
  const posted: HostRequest[] = []
  const panel: HostEvent[] = []
  const forks: number[] = []
  let emit: (event: HostEvent) => void = () => {}
  let die: () => void = () => {}
  let killed = 0
  const terminals = new Terminals({
    fork: (onEvent, onGone): Host => {
      forks.push(forks.length + 1)
      emit = onEvent
      die = onGone
      return { post: (request) => posted.push(request), kill: () => { killed += 1 } }
    },
    toPanel: (event) => panel.push(event),
  })
  const SPEC = { shell: '/bin/zsh', args: ['-i'], cwd: '/work', cols: 80, rows: 24, env: {} }
  return {
    terminals,
    posted,
    panel,
    forks,
    SPEC,
    emit: (event: HostEvent) => emit(event),
    die: () => die(),
    killedHosts: () => killed,
  }
}

describe('Terminals', () => {
  // reason: the host is a second process and node-pty is a native binary;
  // an app nobody opens a terminal in should pay for neither.
  it('starts no host until the first terminal', () => {
    const { terminals, forks } = manager()
    expect(terminals.hostRunning).toBe(false)
    expect(forks).toEqual([])
  })

  it('forks one host and starts the shell on it', () => {
    const { terminals, posted, forks, SPEC } = manager()
    const id = terminals.start(SPEC)
    expect(forks).toHaveLength(1)
    expect(posted).toEqual([{ kind: 'start', id, ...SPEC }])
  })

  it('reuses the host for later terminals', () => {
    const { terminals, forks, SPEC } = manager()
    terminals.start(SPEC)
    terminals.start(SPEC)
    expect(forks).toHaveLength(1)
    expect(terminals.count).toBe(2)
  })

  it('gives each terminal its own id', () => {
    const { terminals, SPEC } = manager()
    expect(terminals.start(SPEC)).not.toBe(terminals.start(SPEC))
  })

  it('passes input, resizes, and acknowledgements through', () => {
    const { terminals, posted, SPEC } = manager()
    const id = terminals.start(SPEC)
    posted.length = 0
    terminals.send({ kind: 'input', id, data: 'ls\r' })
    terminals.send({ kind: 'resize', id, cols: 100, rows: 30 })
    terminals.send({ kind: 'ack', id, chars: 5000 })
    expect(posted).toEqual([
      { kind: 'input', id, data: 'ls\r' },
      { kind: 'resize', id, cols: 100, rows: 30 },
      { kind: 'ack', id, chars: 5000 },
    ])
  })

  // reason: the id arrives from a renderer. Forwarding one this manager never
  // started would let a page address another window's shell.
  it('ignores a request for a terminal it did not start', () => {
    const { terminals, posted } = manager()
    terminals.send({ kind: 'input', id: 42, data: 'rm -rf /\r' })
    expect(posted).toEqual([])
  })

  it('forwards what the host reports to the panel', () => {
    const { terminals, panel, emit, SPEC } = manager()
    const id = terminals.start(SPEC)
    emit({ kind: 'data', id, data: 'hello' })
    expect(panel).toEqual([{ kind: 'data', id, data: 'hello' }])
  })

  it('forgets a terminal once it exits', () => {
    const { terminals, emit, posted, SPEC } = manager()
    const id = terminals.start(SPEC)
    emit({ kind: 'exit', id, code: 0 })
    expect(terminals.count).toBe(0)
    posted.length = 0
    terminals.send({ kind: 'input', id, data: 'x' })
    expect(posted).toEqual([])
  })

  it('forgets one whose shell never started', () => {
    const { terminals, emit, SPEC } = manager()
    const id = terminals.start(SPEC)
    emit({ kind: 'failed', id, reason: 'no such file' })
    expect(terminals.count).toBe(0)
  })

  it('forgets one it killed', () => {
    const { terminals, SPEC } = manager()
    const id = terminals.start(SPEC)
    terminals.send({ kind: 'kill', id })
    expect(terminals.count).toBe(0)
  })

  describe('when the host dies on its own', () => {
    // reason: every shell went with it. A terminal left waiting for output
    // that will never come looks like a hung shell, which is worse than a
    // message saying what happened.
    it('tells every open terminal rather than leaving them waiting', () => {
      const { terminals, panel, die, SPEC } = manager()
      const first = terminals.start(SPEC)
      const second = terminals.start(SPEC)
      panel.length = 0
      die()
      expect(panel).toEqual([
        { kind: 'failed', id: first, reason: 'The terminal process stopped unexpectedly.' },
        { kind: 'failed', id: second, reason: 'The terminal process stopped unexpectedly.' },
      ])
      expect(terminals.count).toBe(0)
    })
  })

  it('starts again on a new host after the old one died', () => {
    const { terminals, forks, die, SPEC } = manager()
    terminals.start(SPEC)
    die()
    expect(terminals.hostRunning).toBe(false)
    terminals.start(SPEC)
    expect(forks).toHaveLength(2)
  })

  it('takes the host down with everything on it', () => {
    const { terminals, killedHosts, SPEC } = manager()
    terminals.start(SPEC)
    terminals.disposeAll()
    expect(killedHosts()).toBe(1)
    expect(terminals.count).toBe(0)
    expect(terminals.hostRunning).toBe(false)
  })
})
