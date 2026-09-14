import { DRIVE_TO_STATE, FRAME_H, FRAME_W, frameAt, type PetDriveState } from './pet-layout.ts'

/**
 * What main pushes into the pet window, and the two gestures it sends back.
 *
 * Declared here, not imported from the preload: the pane never imports from
 * `src/main` or `src/preload`, and this is the shape that crosses the bridge
 * — mirror `src/preload/pet.ts` by hand if it changes.
 */
interface PetBridge {
  onSprite(cb: (spriteDataUrl: string, scale: number) => void): void
  onState(cb: (snap: { state: PetDriveState; badge: boolean }) => void): void
  onTheme(cb: (dark: boolean) => void): void
  activate(): void
  menu(): void
}

declare global {
  interface Window {
    pet: PetBridge
  }
}

const canvas = document.getElementById('pet') as HTMLCanvasElement
const ctx = canvas.getContext('2d')

let sheet: HTMLImageElement | undefined
let scale = 1
let drive: PetDriveState = 'idle'
let badge = false
let startedAt = performance.now()

/** Badge colour comes from a design token, never a literal. */
function badgeColour(): string {
  return getComputedStyle(document.body).getPropertyValue('--dsw-alias-state-business-primary').trim()
}

function resize(): void {
  canvas.width = FRAME_W
  canvas.height = FRAME_H
  canvas.style.width = `${String(FRAME_W * scale)}px`
  canvas.style.height = `${String(FRAME_H * scale)}px`
}

function draw(now: number): void {
  requestAnimationFrame(draw)
  if (ctx === null || sheet === undefined) return
  const { sx, sy, sw, sh } = frameAt(DRIVE_TO_STATE[drive], now - startedAt)
  ctx.clearRect(0, 0, FRAME_W, FRAME_H)
  ctx.drawImage(sheet, sx, sy, sw, sh, 0, 0, FRAME_W, FRAME_H)
  if (badge) {
    const r = 22
    ctx.beginPath()
    ctx.arc(FRAME_W - r - 8, r + 8, r, 0, Math.PI * 2)
    ctx.fillStyle = badgeColour()
    ctx.fill()
  }
}

window.pet.onSprite((dataUrl, nextScale) => {
  scale = nextScale
  resize()
  const img = new Image()
  img.onload = () => {
    sheet = img
  }
  img.src = dataUrl
})

window.pet.onState((snap) => {
  if (snap.state !== drive) {
    drive = snap.state
    startedAt = performance.now()
  }
  badge = snap.badge
})

window.pet.onTheme(() => {
  /* Tokens re-resolve automatically via getComputedStyle on next draw. */
})

canvas.addEventListener('dblclick', () => window.pet.activate())
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.pet.menu()
})

resize()
requestAnimationFrame(draw)
