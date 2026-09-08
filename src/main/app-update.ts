/**
 * Self-update controller for the packaged app, wrapping electron-updater's
 * `autoUpdater` behind a tiny surface that `index.ts` fans out to the tray,
 * a notification, and the Settings window.
 *
 * The backend is injected rather than imported so the whole event→callback
 * mapping is unit-testable against a fake, with no Electron and no network —
 * the same dependency-injection shape `runtime-install.ts` uses for `npm`.
 */

/** The slice of electron-updater's `autoUpdater` this module drives. */
export interface UpdaterBackend {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, cb: (arg: any) => void): void
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

/** Out-of-band notifications from the updater; every one is optional. */
export interface AppUpdaterCallbacks {
  onAvailable?: (version: string) => void
  onReady?: (version: string) => void
  onError?: (error: Error) => void
}

/** What callers drive. */
export interface AppUpdater {
  /** Ask the feed whether a newer version exists; download proceeds automatically. */
  checkNow(): void
  /** Quit and install a downloaded update. No-op until `onReady` has fired. */
  quitAndInstall(): void
}

/**
 * Build the controller.
 *
 * When `packaged` is false the returned controller is inert — no listeners are
 * attached and both methods no-op — so a dev run (`npm start`) is untouched and
 * `electron-updater` (which itself refuses to run unpackaged) is never engaged.
 * @param callbacks - out-of-band event sinks.
 * @param deps - `packaged` (normally `app.isPackaged`) and the `backend`
 *   (normally electron-updater's `autoUpdater`).
 */
export function createAppUpdater(callbacks: AppUpdaterCallbacks, deps: { packaged: boolean; backend: UpdaterBackend }): AppUpdater {
  const { packaged, backend } = deps
  if (!packaged) {
    return { checkNow: () => {}, quitAndInstall: () => {} }
  }

  // Download in the background, but never swap the app out from under the user:
  // installing waits for an explicit `quitAndInstall`.
  backend.autoDownload = true
  backend.autoInstallOnAppQuit = false

  backend.on('update-available', (info: { version: string }) => callbacks.onAvailable?.(info.version))
  backend.on('update-downloaded', (info: { version: string }) => callbacks.onReady?.(info.version))
  // An offline or unreachable feed is not something to crash a launch for.
  backend.on('error', (error: Error) => callbacks.onError?.(error))

  return {
    checkNow: () => {
      // `checkForUpdates` rejects on a dead registry; route it to `onError`
      // rather than let it become an unhandled rejection.
      backend.checkForUpdates().catch((error: unknown) => callbacks.onError?.(error instanceof Error ? error : new Error(String(error))))
    },
    quitAndInstall: () => backend.quitAndInstall(),
  }
}
