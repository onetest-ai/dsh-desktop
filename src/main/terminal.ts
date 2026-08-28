/**
 * Main's half of the terminal: it owns the pty host process and routes
 * messages between it and the panel's page.
 *
 * It holds no node-pty of its own — that lives in the host process, for the
 * reasons in `pty-host.ts` — and no view: the panel's `webContents` arrives
 * per call, so a reloaded or rebuilt view never leaves this holding a stale
 * one.
 *
 * @module terminal
 */

import type { HostEvent, HostRequest } from './pty-host'

/** A running pty host, as this module uses one. */
export interface Host {
  /** Send one request to the host. */
  post(request: HostRequest): void
  /** Stop the host and every shell in it. */
  kill(): void
}

/** What the manager needs from the app around it. */
export interface TerminalDeps {
  /**
   * Start the pty host.
   * @param onEvent - called with everything the host reports.
   * @param onGone - called if the host exits on its own.
   * @returns the running host.
   */
  fork(onEvent: (event: HostEvent) => void, onGone: () => void): Host
  /** Deliver an event to the panel's page, if there is one. */
  toPanel(event: HostEvent): void
}

/**
 * The terminals this app has open, and the one host process behind them.
 *
 * The host is started with the first terminal rather than at boot: an app
 * nobody opens a terminal in never starts a second process, and never loads
 * the native binary.
 */
export class Terminals {
  private host: Host | undefined
  private nextId = 1
  private readonly open = new Set<number>()

  constructor(private readonly deps: TerminalDeps) {}

  /** Whether a host process is running. */
  get hostRunning(): boolean {
    return this.host !== undefined
  }

  /** How many terminals are open. */
  get count(): number {
    return this.open.size
  }

  /**
   * Start a shell.
   * @param spec - what to run, where, and at what size.
   * @returns the id later calls address it by.
   */
  start(spec: Omit<Extract<HostRequest, { kind: 'start' }>, 'kind' | 'id'>): number {
    const id = this.nextId
    this.nextId += 1
    this.open.add(id)
    this.ensureHost().post({ kind: 'start', id, ...spec })
    return id
  }

  /**
   * Pass something on to a running shell.
   * @param request - the request, for a terminal this manager started.
   */
  send(request: HostRequest): void {
    if (!this.open.has(request.id)) return
    if (request.kind === 'kill') this.open.delete(request.id)
    this.host?.post(request)
  }

  /** Stop every shell and the host with them. */
  disposeAll(): void {
    this.host?.kill()
    this.host = undefined
    this.open.clear()
  }

  /**
   * The host, started if it is not running.
   * @returns the running host.
   */
  private ensureHost(): Host {
    if (this.host !== undefined) return this.host
    this.host = this.deps.fork(
      (event) => {
        if (event.kind === 'exit' || event.kind === 'failed') this.open.delete(event.id)
        this.deps.toPanel(event)
      },
      () => {
        // The host died — a node-pty crash, or the OS killing it. Every shell
        // went with it, so each terminal is told rather than left waiting for
        // output that will never come. The next `start` forks a new host.
        this.host = undefined
        for (const id of [...this.open]) {
          this.open.delete(id)
          this.deps.toPanel({ kind: 'failed', id, reason: 'The terminal process stopped unexpectedly.' })
        }
      },
    )
    return this.host
  }
}
