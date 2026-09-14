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
 * Room the harness-style compose bar needs in the controls row's own slot:
 * the top framing row (workspace + mode), the input at its tallest auto-grown
 * state (`max-height` a few lines), and the bottom framing row (model + send)
 * — plus the panel's padding and the chrome's. Sized for the *tallest* state
 * on purpose: the window is a fixed size while composing (the renderer can't
 * resize it as the input grows), so it must fit the input fully grown, and
 * when the message is short the bar is shorter and the extra room below it is
 * just transparent, unpainted window. Mirrors the panel's own CSS heights in
 * `pet.html` by hand. The panel *replaces* the controls row rather than
 * adding beneath it (see `#pet-chrome`, where `#pet-controls` is hidden while
 * composing), so this is the slot's whole height while composing, not an
 * addition to `CONTROLS_ROW_H`. Fixed in window pixels rather than scaled
 * with the sprite, for the same reason `CONTROLS_ROW_H` is.
 */
const COMPOSE_PANEL_H = 196
/**
 * Floor on content width so the roomy input has real width to grow into —
 * wide enough that the placeholder ("Type a message… Enter to send") fits
 * on one line at the panel's own font/padding, even when the sprite itself
 * is scaled down small.
 */
const COMPOSE_PANEL_MIN_W = 380

/**
 * The pet window's content size while the compose panel is open: the same
 * sprite region as `petWindowSize`, but with the bottom slot swapped from
 * the controls row's height/width floor to the panel's own — it replaces
 * that row in place rather than growing past it, so the sprite above never
 * shifts. `syncPet`/the `pet:compose-open` handler swap between this and
 * `petWindowSize` as the panel opens and closes; both callers resize via
 * `setBounds` with the window's current `x`/`y` so the top-left corner the
 * window was placed at stays put and only the bottom-right moves.
 */
export function petComposePanelSize(scale: number): { width: number; height: number } {
  const spriteW = Math.round(PET_FRAME.w * scale)
  const spriteH = Math.round((PET_FRAME.h + BUBBLE_BAND) * scale)
  return { width: Math.max(spriteW, COMPOSE_PANEL_MIN_W), height: spriteH + COMPOSE_PANEL_H }
}

/**
 * Resizes the pet window to `size`, keeping the *sprite's horizontal centre*
 * fixed and its top fixed — only the width grows/shrinks symmetrically
 * around the centre, and height only ever grows downward.
 * `setContentSize`/`setSize` alone are not safe here: this window is
 * frameless and can sit anywhere on screen, and nothing in Electron's
 * contract promises they anchor the top-left rather than recentering or
 * growing from the window's center on some platform.
 *
 * The sprite is horizontally centered in the window (`body { align-items:
 * center }` in pet.html), so pinning the top-left x — the previous
 * behaviour — visibly shoves the otter sideways whenever the compose panel
 * (wider than the idle window) opens or closes. Splitting the width delta
 * evenly onto `x` keeps the sprite's centre — and so the sprite itself —
 * exactly where it was, in both directions. `y` stays put; only the bottom
 * edge moves as height changes, since the controls/compose slot is always
 * *below* the sprite.
 */
export function resizePetWindow(win: BrowserWindow, size: { width: number; height: number }): void {
  const { x, y, width } = win.getBounds()
  const newX = x + Math.round((width - size.width) / 2)
  win.setBounds({ x: newX, y, width: size.width, height: size.height })
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
