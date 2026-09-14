import { BrowserWindow, screen } from 'electron'
import { PET_FRAME } from './pet-catalog'

export interface PetWindowDeps {
  preloadPath: string
  paneOrigin: string
}

/**
 * Vertical room reserved above the sprite for the speech bubble. Mirrors
 * `BUBBLE_BAND` in `src/renderer/pane/pet-layout.ts` by hand — the renderer
 * pane never imports from main, so this constant is kept equal on both sides
 * rather than shared.
 */
const BUBBLE_BAND = 96

/**
 * Fixed-CSS-px room below the sprite for the always-visible icon-button row
 * (compose pencil + notification bell). Not scaled with the sprite — the
 * pet-window.spec.ts and pet.html `#pet-chrome` padding are kept equal to
 * this by hand, the same way `BUBBLE_BAND` already mirrors `pet-layout.ts`.
 */
const CONTROLS_ROW_H = 44
/** Floor on content width so the two circular icon buttons have breathing
 * room even when the sprite itself is scaled down small. */
const CONTROLS_ROW_MIN_W = 96

/**
 * The pet's window, idle (compose closed): the bubble band, the sprite, and
 * the controls row below it — top to bottom, nothing overlapping the
 * sprite. The renderer draws the bubble+sprite into the canvas at the top
 * and lays the controls row out as ordinary DOM beneath it, so this is kept
 * as a pure function so the size can be asserted without an Electron
 * runtime.
 */
export function petWindowSize(scale: number): { width: number; height: number } {
  const spriteW = Math.round(PET_FRAME.w * scale)
  const spriteH = Math.round((PET_FRAME.h + BUBBLE_BAND) * scale)
  return { width: Math.max(spriteW, CONTROLS_ROW_MIN_W), height: spriteH + CONTROLS_ROW_H }
}

/**
 * Extra room the compose panel needs below the controls row: a project
 * chip, a big roomy input, and its send control — the Codex-style generous
 * box the design calls for, not the old cramped pill. Fixed in window
 * pixels rather than scaled with the sprite, for the same reason
 * `CONTROLS_ROW_H` is.
 */
const COMPOSE_PANEL_H = 150
/** Floor on content width so the roomy input has real width to grow into,
 * even when the sprite itself is scaled down small. */
const COMPOSE_PANEL_MIN_W = 300

/**
 * The pet window's content size while the compose panel is open: the idle
 * box, stretched downward to fit the panel below the controls row.
 * `syncPet`/the `pet:compose-open` handler swap between this and
 * `petWindowSize` as the panel opens and closes — the sprite's own region
 * at the top never moves, only the window grows taller beneath it.
 */
export function petComposePanelSize(scale: number): { width: number; height: number } {
  const base = petWindowSize(scale)
  return { width: Math.max(base.width, COMPOSE_PANEL_MIN_W), height: base.height + COMPOSE_PANEL_H }
}

/**
 * A frameless, transparent, always-on-top window that floats the pet over every
 * other app. Modeled on settings-window.ts but non-activating chrome: no frame,
 * no shadow, not in the taskbar, visible across spaces and full-screen apps so
 * the pet stays with you. The renderer is a pure puppet — all state is pushed in.
 */
export function createPetWindow(opts: {
  scale: number
  position?: { x: number; y: number }
  deps: PetWindowDeps
}): BrowserWindow {
  const { width, height } = petWindowSize(opts.scale)
  const fallback = defaultCorner(width, height)
  const win = new BrowserWindow({
    width,
    height,
    x: opts.position?.x ?? fallback.x,
    y: opts.position?.y ?? fallback.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: opts.deps.preloadPath,
    },
  })
  // 'floating' keeps the pet above ordinary windows without stealing focus, and
  // showInactive on ready-to-show means summoning the pet never pulls the user
  // out of whatever they were typing into.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.once('ready-to-show', () => win.showInactive())
  void win.loadURL(`${opts.deps.paneOrigin}/pet.html`)
  return win
}

/** Bottom-right of the primary display's work area, inset so it clears the edge. */
function defaultCorner(width: number, height: number): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height - 24 }
}
