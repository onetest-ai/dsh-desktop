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
  /**
   * @param status - the server status to render.
   * @param note - a non-blocking condition discovered at boot (e.g. the hook
   *   bridge could not be mounted), appended to the tooltip and shown as a
   *   disabled menu row; omit when there is none.
   */
  setStatus(status: ServerStatus, note?: string): void
  /**
   * Show that a newer harness is available.
   *
   * Here rather than only in Settings, because the check no longer waits for
   * that window to be opened — and the tray is the one surface of this app
   * the user sees without asking for it.
   * @param version - the version available, or undefined to drop the row.
   */
  setUpdate(version: string | undefined): void
  destroy(): void
}

/** Longest note a menu item can carry before it distorts the menu's width. */
const NOTE_MAX = 80

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

  let update: string | undefined
  /** What the menu is currently showing, so the update row can be added without it. */
  let current: { status: ServerStatus; note?: string } = { status: 'starting' }

  const render = (status: ServerStatus, note?: string): void => {
    current = { status, ...(note === undefined ? {} : { note }) }
    // A menu item renders its label on one unwrapped line, so an over-long
    // note stretches the menu across the screen. Callers are expected to pass
    // something short; this is the backstop that keeps a future long note from
    // breaking the menu outright.
    const shown = note === undefined || note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 1)}…`
    tray.setImage(icon(status))
    tray.setToolTip(shown !== undefined ? `${LABELS[status]} — ${shown}` : LABELS[status])
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: LABELS[status], enabled: false },
        ...(shown !== undefined ? [{ label: shown, enabled: false }] : []),
        { type: 'separator' },
        { label: 'Show / Hide', click: () => actions.toggleWindow() },
        { label: 'Restart harness', click: () => actions.restart() },
        { label: 'Settings…', click: () => actions.openSettings() },
        // Only when there is one: an item saying nothing is available is a
        // line the user reads every time to learn nothing.
        ...(update === undefined
          ? []
          : [{ label: `Update available: ${update}`, click: () => actions.openSettings() }]),
        { type: 'separator' },
        { label: 'Quit', click: () => actions.quit() },
      ]),
    )
  }

  render('starting')

  return {
    setStatus: render,
    setUpdate: (version) => {
      if (version === update) return
      update = version
      // Re-rendered with what the menu is already showing: the update row is
      // one line in a menu whose other lines are not this function's to know.
      render(current.status, current.note)
    },
    destroy: () => tray.destroy(),
  }
}

function icon(status: ServerStatus) {
  const { file, template } = ICONS[status]
  const image = nativeImage.createFromPath(join(ASSETS, file))
  image.setTemplateImage(template)
  return image
}
