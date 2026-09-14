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
 * The pet's window is one sprite frame, scaled, plus a band above it for the
 * speech bubble. The renderer draws the sprite in the lower `PET_FRAME.h`
 * region and the bubble in the band above — kept as a pure function so the
 * size can be asserted without an Electron runtime.
 */
export function petWindowSize(scale: number): { width: number; height: number } {
  return { width: Math.round(PET_FRAME.w * scale), height: Math.round((PET_FRAME.h + BUBBLE_BAND) * scale) }
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
