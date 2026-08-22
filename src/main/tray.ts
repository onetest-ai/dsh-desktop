import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import type { ServerStatus } from './status'

/** What the tray menu can ask the app to do. */
export interface TrayActions {
  toggleWindow(): void
  restart(): void
  openSettings(): void
  quit(): void
}

/** Live handle on the tray icon. */
export interface TrayController {
  setStatus(status: ServerStatus): void
  destroy(): void
}

const ASSETS = join(__dirname, '..', '..', 'assets')

const LABELS: Record<ServerStatus, string> = {
  starting: 'Harness: starting…',
  running: 'Harness: running',
  failed: 'Harness: failed',
}

const ICONS: Record<ServerStatus, string> = {
  starting: 'tray-starting.png',
  running: 'tray-running.png',
  failed: 'tray-failed.png',
}

/**
 * Create the menu-bar tray item.
 * @param actions - callbacks the menu items invoke.
 * @returns a controller for status updates and teardown.
 */
export function createTray(actions: TrayActions): TrayController {
  const tray = new Tray(icon('starting'))

  const render = (status: ServerStatus): void => {
    tray.setImage(icon(status))
    tray.setToolTip(LABELS[status])
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: LABELS[status], enabled: false },
        { type: 'separator' },
        { label: 'Show / Hide', click: () => actions.toggleWindow() },
        { label: 'Restart harness', click: () => actions.restart() },
        { label: 'Settings…', click: () => actions.openSettings() },
        { type: 'separator' },
        { label: 'Quit', click: () => actions.quit() },
      ]),
    )
  }

  render('starting')

  return {
    setStatus: render,
    destroy: () => tray.destroy(),
  }
}

function icon(status: ServerStatus) {
  const image = nativeImage.createFromPath(join(ASSETS, ICONS[status]))
  image.setTemplateImage(true)
  return image
}
