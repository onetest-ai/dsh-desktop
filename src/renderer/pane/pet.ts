import { BUBBLE_BAND, DRIVE_TO_STATE, FRAME_H, FRAME_W, bubbleLayout, frameAt, type PetDriveState } from './pet-layout.ts'

/**
 * What main pushes into the pet window, and the two gestures it sends back.
 *
 * Declared here, not imported from the preload: the pane never imports from
 * `src/main` or `src/preload`, and this is the shape that crosses the bridge
 * — mirror `src/preload/pet.ts` by hand if it changes. `text` is optional:
 * main starts sending it once the state machine carries bubble copy, but
 * this side treats an absent field the same as an empty bubble.
 */
/**
 * The rich compose round trip. Re-declared here for the same reason as the
 * rest of `PetBridge` — mirror `ComposeRequest`/`ComposerOptions` in
 * `src/preload/pet.ts` by hand.
 */
interface ComposeRequest {
  text: string
  workspaceId?: string
  model?: string
  send: boolean
}
interface ComposerOptions {
  workspaces: { id: string; title: string; current: boolean }[]
  models?: { id: string; label: string; current: boolean }[]
}

interface PetBridge {
  onSprite(cb: (spriteDataUrl: string, scale: number) => void): void
  onState(cb: (snap: { state: PetDriveState; badge: boolean; text?: string }) => void): void
  onTheme(cb: (dark: boolean) => void): void
  activate(): void
  menu(): void
  compose(text: string): void
  onComposerOptions(cb: (opts: ComposerOptions) => void): void
  composeRich(req: ComposeRequest): void
  setComposeOpen(open: boolean): void
}

declare global {
  interface Window {
    pet: PetBridge
  }
}

/** The full canvas height: the bubble band above the sprite, plus the sprite itself. */
const CANVAS_H = FRAME_H + BUBBLE_BAND
/** Side margin the bubble rectangle keeps from the canvas edges. */
const BUBBLE_MARGIN_X = 8
/** Gap between the bubble's tail tip and the top of the sprite region. */
const BUBBLE_GAP = 4
const BUBBLE_TAIL_H = 8
const BUBBLE_RADIUS = 8
/** Size and placement of the missed-turn badge, top-right of the sprite region (not the bubble band). */
const BADGE_W = 26
const BADGE_H = 19
const BADGE_MARGIN = 6
const BADGE_RADIUS = 5

const canvas = document.getElementById('pet') as HTMLCanvasElement
const ctx = canvas.getContext('2d')

// Computed once: this never changes for the life of the window, and reduced
// motion means "don't cycle frames", not "don't ever redraw" — state changes
// (a new drive state, new badge, new bubble text) still repaint.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

let sheet: HTMLImageElement | undefined
let scale = 1
let drive: PetDriveState = 'idle'
let badge = false
let bubbleText = ''
let startedAt = performance.now()

/** Reads one design token off `body`, trimmed — never a colour literal. */
function token(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim()
}

function resize(): void {
  canvas.width = FRAME_W
  canvas.height = CANVAS_H
  canvas.style.width = `${String(FRAME_W * scale)}px`
  canvas.style.height = `${String(CANVAS_H * scale)}px`
}

/** Paints the speech bubble in the band above the sprite, tail pointing down at it. Does nothing when there's no text. */
function drawBubble(): void {
  if (ctx === null || bubbleText === '') return
  const maxWidth = FRAME_W - BUBBLE_MARGIN_X * 2
  const { text, rectW, rectH } = bubbleLayout(bubbleText, maxWidth)
  const x = (FRAME_W - rectW) / 2
  const y = Math.max(0, BUBBLE_BAND - BUBBLE_TAIL_H - rectH - BUBBLE_GAP)
  const tailX = FRAME_W / 2

  const bg = token('--dsw-alias-tooltip-bg')
  const fg = token('--dsw-alias-label-primary-foreground')
  const border = token('--dsw-alias-border-l2')

  ctx.beginPath()
  ctx.roundRect(x, y, rectW, rectH, BUBBLE_RADIUS)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = border
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(tailX - 6, y + rectH - 1)
  ctx.lineTo(tailX + 6, y + rectH - 1)
  ctx.lineTo(tailX, y + rectH + BUBBLE_TAIL_H)
  ctx.closePath()
  ctx.fillStyle = bg
  ctx.fill()

  ctx.fillStyle = fg
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, tailX, y + rectH / 2)
}

/**
 * Paints the "unseen finished turn" indicator: an envelope glyph rather than
 * a plain dot, so it reads as a notification at a glance. Anchored to the
 * top-right of the sprite region (below the bubble band, never inside it).
 */
function drawBadge(): void {
  if (ctx === null) return
  const x = FRAME_W - BADGE_W - BADGE_MARGIN
  const y = BUBBLE_BAND + BADGE_MARGIN

  const fill = token('--dsw-alias-state-business-primary')
  const ring = token('--dsw-alias-border-l2')
  const flap = token('--dsw-alias-label-primary-foreground')

  ctx.beginPath()
  ctx.roundRect(x, y, BADGE_W, BADGE_H, BADGE_RADIUS)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = ring
  ctx.stroke()

  // The envelope's folded flap, drawn as two strokes from the top corners
  // down to the badge's bottom-centre — the detail that reads as "mail",
  // not just a coloured shape.
  ctx.beginPath()
  ctx.moveTo(x + 2, y + 2)
  ctx.lineTo(x + BADGE_W / 2, y + BADGE_H / 2 + 1)
  ctx.lineTo(x + BADGE_W - 2, y + 2)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = flap
  ctx.stroke()
}

function draw(now: number): void {
  requestAnimationFrame(draw)
  if (ctx === null || sheet === undefined) return
  const elapsed = reducedMotion ? 0 : now - startedAt
  const { sx, sy, sw, sh } = frameAt(DRIVE_TO_STATE[drive], elapsed)
  ctx.clearRect(0, 0, FRAME_W, CANVAS_H)
  ctx.drawImage(sheet, sx, sy, sw, sh, 0, BUBBLE_BAND, FRAME_W, FRAME_H)
  if (badge) drawBadge()
  drawBubble()
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
  // main and the pane re-declare this union by hand (see the PetBridge doc
  // comment above); an unrecognized state here would make frameAt read
  // PET_LAYOUT[undefined] and throw on every animation frame, freezing the
  // pet — fall back to 'idle' rather than trust the wire value blindly.
  const next = DRIVE_TO_STATE[snap.state] !== undefined ? snap.state : 'idle'
  if (next !== drive) {
    drive = next
    startedAt = performance.now()
  }
  badge = snap.badge
  bubbleText = snap.text ?? ''
})

window.pet.onTheme((dark) => {
  // Matches theme.ts / settings.js / shell.js: `--dsw-alias-*` tokens are
  // keyed off `body[data-ds-dark-theme]`, not `prefers-color-scheme`.
  document.body.toggleAttribute('data-ds-dark-theme', dark)
})

canvas.addEventListener('dblclick', () => window.pet.activate())
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.pet.menu()
})

// Click-to-compose. The pencil is a `no-drag` island in the otherwise-draggable
// window (see pet.html), so toggling the input can never be confused with the
// start of a window drag — the source of the classic click-vs-drag ambiguity.
// Which UI opens depends on whether the harness plugin has ever reported
// `ComposerOptions`: until it has, this is the plain one-line input +
// `window.pet.compose` (today's DOM insert+send, always available); once
// options arrive, the pencil opens the rich panel + `composeRich` instead —
// the plugin may simply not be loaded, and the plain path never goes away.
const composeToggle = document.getElementById('compose-toggle') as HTMLButtonElement
const composeInput = document.getElementById('compose-input') as HTMLInputElement
const composePanel = document.getElementById('compose-panel') as HTMLDivElement
const composeText = document.getElementById('compose-text') as HTMLTextAreaElement
const composeProject = document.getElementById('compose-project') as HTMLSelectElement
const composeModel = document.getElementById('compose-model') as HTMLSelectElement
const composeSend = document.getElementById('compose-send') as HTMLButtonElement

/** Latest options the harness plugin has reported, or `undefined` before the first one arrives. */
let composerOptions: ComposerOptions | undefined

/** True once real workspace data has arrived — the signal to use the rich panel over the plain input. */
function hasRichOptions(): boolean {
  return composerOptions !== undefined && composerOptions.workspaces.length > 0
}

/** Rebuilds `<select>` from `{id, label}` rows, selecting `selectedId` (or the row marked current). */
function fillSelect(select: HTMLSelectElement, rows: { id: string; label: string; current: boolean }[]): void {
  select.replaceChildren(
    ...rows.map((row) => {
      const opt = document.createElement('option')
      opt.value = row.id
      opt.textContent = row.label
      if (row.current) opt.selected = true
      return opt
    }),
  )
}

/** Populates the project/model selects from the latest options and shows only the ones with rows to offer. */
function populatePanel(): void {
  const opts = composerOptions
  if (opts === undefined) return
  fillSelect(
    composeProject,
    opts.workspaces.map((w) => ({ id: w.id, label: w.title, current: w.current })),
  )
  composeProject.hidden = opts.workspaces.length === 0
  const models = opts.models ?? []
  fillSelect(composeModel, models)
  composeModel.hidden = models.length === 0
}

function openCompose(): void {
  window.pet.setComposeOpen(true)
  if (hasRichOptions()) {
    populatePanel()
    composePanel.hidden = false
    composeText.focus()
  } else {
    composeInput.hidden = false
    composeInput.focus()
  }
}

function closeCompose(): void {
  composeInput.value = ''
  composeInput.hidden = true
  composeText.value = ''
  composePanel.hidden = true
  window.pet.setComposeOpen(false)
}

function submitCompose(): void {
  const text = composeInput.value.trim()
  if (text !== '') window.pet.compose(text)
  closeCompose()
}

function submitComposeRich(): void {
  const text = composeText.value.trim()
  if (text !== '') {
    const req: ComposeRequest = {
      text,
      workspaceId: composeProject.hidden || composeProject.value === '' ? undefined : composeProject.value,
      model: composeModel.hidden || composeModel.value === '' ? undefined : composeModel.value,
      send: true,
    }
    window.pet.composeRich(req)
  }
  closeCompose()
}

// Keep focus on the panel while the pencil is pressed: without this the panel's
// own blur-out (below) fires on the toggle's mousedown and closes it just before
// the click handler runs, so the pencil could only ever open, never close it.
composeToggle.addEventListener('mousedown', (e) => e.preventDefault())
composeToggle.addEventListener('click', () => {
  if (composeInput.hidden && composePanel.hidden) openCompose()
  else closeCompose()
})

composeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    submitCompose()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeCompose()
  }
})

// Blur closes it (clicking away or the window losing focus). Empty is discarded.
composeInput.addEventListener('blur', () => closeCompose())

// The panel closes on Escape from any of its controls, and Enter-to-send only
// from the text field (Shift+Enter is a newline; the selects/button get their
// own native Enter behaviour, which would otherwise double-fire a submit).
// Blur closes it too, but only once focus has actually left the panel — a tab
// or click between the textarea and a select is not "clicking away".
composePanel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeCompose()
  } else if (e.key === 'Enter' && e.target === composeText && !e.shiftKey) {
    e.preventDefault()
    submitComposeRich()
  }
})
composePanel.addEventListener('focusout', (e) => {
  const next = e.relatedTarget
  if (next instanceof Node && composePanel.contains(next)) return
  closeCompose()
})
composeSend.addEventListener('click', () => submitComposeRich())

window.pet.onComposerOptions((opts) => {
  composerOptions = opts
})

resize()
requestAnimationFrame(draw)
