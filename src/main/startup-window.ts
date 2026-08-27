import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { Finding } from './healthcheck'

/** Which phase the startup surface is showing. */
export type StartupPhase = 'checking' | 'repairing' | 'starting' | 'failed'

/** Registered once per process; `ipcMain.handle` throws on a second registration. */
let channelsRegistered = false

/**
 * Splash dimensions, 16:9 to match `splash.png`.
 *
 * The window is sized to the artwork rather than the artwork fitted into a
 * window: a splash whose image is a strip inside empty chrome reads as a page
 * that failed to load.
 */
const SPLASH_WIDTH = 720
const SPLASH_HEIGHT = 405

/**
 * Open the frameless splash window.
 *
 * A window of its own rather than the main window: the main window is
 * 1280x860 with a title bar and stays hidden until the harness URL paints in
 * it, so a startup surface living there would be a small block stranded in a
 * large empty frame.
 * @param actions - what the surface's two buttons do.
 * @returns the splash window, once its page has loaded.
 */
export async function showStartup(actions: {
  openSettings(): void
  continueAnyway(): void
}): Promise<BrowserWindow> {
  if (!channelsRegistered) {
    ipcMain.handle('startup:open-settings', () => {
      actions.openSettings()
    })
    ipcMain.handle('startup:continue-anyway', () => {
      actions.continueAnyway()
    })
    channelsRegistered = true
  }
  const splash = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    // The artwork is dark, so a default white ground would flash before the
    // image paints.
    backgroundColor: '#060e1e',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'startup.js'),
    },
  })
  splash.once('ready-to-show', () => splash.show())
  await splash.loadFile(join(__dirname, '..', 'renderer', 'startup.html'))
  return splash
}

/**
 * Close the splash, if it is still open.
 *
 * Called when the main window appears and when the app quits; both may happen
 * after the splash has already gone, so a closed splash is not an error.
 * @param splash - the splash window, or undefined if it was never opened.
 */
export function closeStartup(splash: BrowserWindow | undefined): void {
  if (splash === undefined || splash.isDestroyed()) return
  splash.destroy()
}

/**
 * Send one message to the startup surface, if it is still there.
 *
 * Every push is guarded: the splash is destroyed the moment the main window
 * appears, and a late push into a destroyed window would throw on a path
 * whose whole job is to not break the launch.
 * @param splash - the splash window, or undefined before it exists.
 * @param channel - the channel to send on.
 * @param payload - the value to send.
 */
function push(splash: BrowserWindow | undefined, channel: string, payload: unknown): void {
  if (splash === undefined || splash.isDestroyed()) return
  splash.webContents.send(channel, payload)
}

/**
 * Show what the healthcheck found.
 * @param splash - the splash window.
 * @param findings - every finding, in check order.
 */
export function pushFindings(splash: BrowserWindow | undefined, findings: Finding[]): void {
  push(splash, 'startup:findings', findings)
}

/**
 * Move the surface to a phase.
 * @param splash - the splash window.
 * @param phase - the phase now current.
 */
export function pushPhase(splash: BrowserWindow | undefined, phase: StartupPhase): void {
  push(splash, 'startup:phase', phase)
}

/**
 * Append one line of install output.
 * @param splash - the splash window.
 * @param line - the line to append.
 */
export function pushProgress(splash: BrowserWindow | undefined, line: string): void {
  push(splash, 'startup:progress', line)
}
