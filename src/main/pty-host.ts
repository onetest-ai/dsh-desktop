/**
 * The pty host: the only process in this app that loads node-pty.
 *
 * Its own process, not main's, for the reasons VS Code moved theirs out of the
 * renderer (microsoft/vscode#74620): a node-pty crash takes down whatever
 * process it is in, and a program producing output in a tight loop blocks that
 * process's event loop. In main those would take the whole app — the harness
 * views, the MCP server, the project watcher — rather than one panel.
 *
 * It speaks a small message protocol over the utility process channel and
 * holds no policy: which shell, which directory, and when to start are all
 * decided in main and arrive in `start`.
 *
 * @module pty-host
 */

import { FlowControl } from './pty-flow'

/** What main asks the host to do. */
export type HostRequest =
  | { kind: 'start'; id: number; shell: string; args: string[]; cwd: string; cols: number; rows: number; env: Record<string, string> }
  | { kind: 'input'; id: number; data: string }
  | { kind: 'resize'; id: number; cols: number; rows: number }
  | { kind: 'ack'; id: number; chars: number }
  | { kind: 'kill'; id: number }

/** What the host reports back. */
export type HostEvent =
  | { kind: 'data'; id: number; data: string }
  | { kind: 'exit'; id: number; code: number; signal?: number }
  | { kind: 'failed'; id: number; reason: string }

/** One running shell and the flow control for its output. */
interface Session {
  pty: { write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: () => void; pause: () => void; resume: () => void }
  flow: FlowControl
}

/** The pty module, loaded only when a terminal is actually opened. */
type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: { name: string; cwd: string; cols: number; rows: number; env: Record<string, string> },
  ) => {
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    kill: () => void
    pause: () => void
    resume: () => void
    onData: (listener: (data: string) => void) => void
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void
  }
}

/**
 * Run the host over a message channel.
 *
 * Takes its transport rather than reaching for `process.parentPort`, so the
 * protocol can be exercised without starting a process.
 * @param channel - how it receives requests and reports events.
 * @param load - loads node-pty; injected so a test never needs the real one.
 * @returns a disposer that kills every running shell.
 */
export function runPtyHost(
  channel: { onRequest: (listener: (request: HostRequest) => void) => void; send: (event: HostEvent) => void },
  load: () => PtyModule,
): () => void {
  const sessions = new Map<number, Session>()

  channel.onRequest((request) => {
    if (request.kind === 'start') {
      if (sessions.has(request.id)) return
      let pty: ReturnType<PtyModule['spawn']>
      try {
        pty = load().spawn(request.shell, request.args, {
          name: 'xterm-256color',
          cwd: request.cwd,
          cols: request.cols,
          rows: request.rows,
          env: request.env,
        })
      } catch (error) {
        // The shell was removed, is not executable, or the working directory
        // is gone. Reported rather than thrown: this process staying up is
        // what lets the next terminal try again.
        channel.send({ kind: 'failed', id: request.id, reason: (error as Error).message })
        return
      }
      const session: Session = { pty, flow: new FlowControl() }
      sessions.set(request.id, session)
      pty.onData((data) => {
        channel.send({ kind: 'data', id: request.id, data })
        if (session.flow.wrote(data.length) === 'pause') pty.pause()
      })
      pty.onExit(({ exitCode, signal }) => {
        // Only for a session still registered. A shell killed on the way out
        // is deleted before the signal, and would otherwise report an exit
        // for a terminal main has already forgotten.
        if (!sessions.delete(request.id)) return
        channel.send({ kind: 'exit', id: request.id, code: exitCode, ...(signal === undefined ? {} : { signal }) })
      })
      return
    }
    const session = sessions.get(request.id)
    if (session === undefined) return
    if (request.kind === 'input') session.pty.write(request.data)
    else if (request.kind === 'resize') session.pty.resize(request.cols, request.rows)
    else if (request.kind === 'ack') {
      if (session.flow.acknowledged(request.chars) === 'resume') session.pty.resume()
    } else {
      // Removed before the kill so a shell that exits on the signal does not
      // also arrive here through `onExit` and report twice.
      sessions.delete(request.id)
      session.pty.kill()
    }
  })

  return () => {
    for (const session of sessions.values()) session.pty.kill()
    sessions.clear()
  }
}
