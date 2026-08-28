/**
 * The utility process's entry point: wire {@link runPtyHost} to the real
 * channel and the real node-pty.
 *
 * Separate from `pty-host.ts` so the protocol can be tested without a process
 * and without the native module. Everything platform- and Electron-specific
 * is here, and it is the only file that names node-pty.
 *
 * @module pty-entry
 */

import { runPtyHost, type HostRequest } from './pty-host'

// `parentPort` exists only inside a utility process; this file is never
// imported anywhere else.
const port = process.parentPort

const dispose = runPtyHost(
  {
    onRequest: (listener) => {
      port.on('message', (message: { data: HostRequest }) => {
        listener(message.data)
      })
    },
    send: (event) => {
      port.postMessage(event)
    },
  },
  // Required here rather than at the top: the native binary is loaded when a
  // terminal is first opened, so an app nobody opens one in never loads it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  () => require('node-pty') as never,
)

// A host told to go takes its shells with it; without this they outlive the
// app as orphans holding the workspace open.
process.on('exit', dispose)
