import { ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { Finding } from './healthcheck'

/** Which phase the startup surface is showing. */
export type StartupPhase = 'checking' | 'repairing' | 'starting' | 'failed'

/** Registered once per process; `ipcMain.handle` throws on a second registration. */
let channelsRegistered = false

/**
 * Show the startup surface in the main window.
 *
 * Loaded into the window the harness will later occupy, rather than a window
 * of its own: the harness URL replaces it when boot succeeds, so there is one
 * window whose content changes and never a second one to close.
 * @param window - the main window.
 * @param actions - what the surface's two buttons do.
 * @returns resolution once the page has loaded.
 */
export async function showStartup(
  window: BrowserWindow,
  actions: { openSettings(): void; continueAnyway(): void },
): Promise<void> {
  if (!channelsRegistered) {
    ipcMain.handle('startup:open-settings', () => {
      actions.openSettings()
    })
    ipcMain.handle('startup:continue-anyway', () => {
      actions.continueAnyway()
    })
    channelsRegistered = true
  }
  await window.loadFile(join(__dirname, '..', 'renderer', 'startup.html'))
}

/**
 * Send one message to the startup surface, if it is still there.
 *
 * Every push is guarded: the harness URL replaces this page the moment boot
 * succeeds, and a late push into a destroyed or navigated window would throw
 * on a path whose whole job is to not break the launch.
 * @param window - the main window, or undefined before it exists.
 * @param channel - the channel to send on.
 * @param payload - the value to send.
 */
function push(window: BrowserWindow | undefined, channel: string, payload: unknown): void {
  if (window === undefined || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

/**
 * Show what the healthcheck found.
 * @param window - the main window.
 * @param findings - every finding, in check order.
 */
export function pushFindings(window: BrowserWindow | undefined, findings: Finding[]): void {
  push(window, 'startup:findings', findings)
}

/**
 * Move the surface to a phase.
 * @param window - the main window.
 * @param phase - the phase now current.
 */
export function pushPhase(window: BrowserWindow | undefined, phase: StartupPhase): void {
  push(window, 'startup:phase', phase)
}

/**
 * Append one line of install output.
 * @param window - the main window.
 * @param line - the line to append.
 */
export function pushProgress(window: BrowserWindow | undefined, line: string): void {
  push(window, 'startup:progress', line)
}
