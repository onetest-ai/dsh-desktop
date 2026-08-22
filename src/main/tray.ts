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

/**
 * Menu-bar art per status, as 16pt images with `@2x` companions beside them
 * (`nativeImage` picks the retina file by that naming convention).
 *
 * The DeepSeek mark carries fine internal detail that turns to mush at 16pt
 * once anything is layered over it, so a failed harness is distinguished by
 * colour rather than by a badge or slash: `Template` art is recoloured by
 * macOS to match the menu bar, while the failed icon is deliberately NOT a
 * template so its red survives.
 */
const ICONS: Record<ServerStatus, { file: string; template: boolean }> = {
  starting: { file: 'tray-startingTemplate.png', template: true },
  running: { file: 'tray-runningTemplate.png', template: true },
  failed: { file: 'tray-failed.png', template: false },
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
  const { file, template } = ICONS[status]
  const image = nativeImage.createFromPath(join(ASSETS, file))
  image.setTemplateImage(template)
  return image
}
