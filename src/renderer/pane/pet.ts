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
  currentMode?: string
  currentModel?: string
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
  const fg = token('--dsw-alias-label-primary')
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

function draw(now: number): void {
  requestAnimationFrame(draw)
  if (ctx === null || sheet === undefined) return
  const elapsed = reducedMotion ? 0 : now - startedAt
  const { sx, sy, sw, sh } = frameAt(DRIVE_TO_STATE[drive], elapsed)
  ctx.clearRect(0, 0, FRAME_W, CANVAS_H)
  ctx.drawImage(sheet, sx, sy, sw, sh, 0, BUBBLE_BAND, FRAME_W, FRAME_H)
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
  notifyBadge.hidden = !badge
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
// window (see pet.html), so toggling the panel can never be confused with the
// start of a window drag — the source of the classic click-vs-drag ambiguity.
// One panel serves both paths now; only the workspace chip differs by data.
// Which round trip fires on submit depends on whether the harness plugin has
// ever reported `ComposerOptions`: until it has, this is `window.pet.compose`
// (today's DOM insert+send, always available); once options arrive with at
// least one workspace, submit uses `composeRich` instead — the plugin may
// simply not be loaded, and the plain path never goes away.
const composeToggle = document.getElementById('compose-toggle') as HTMLButtonElement
const notifyToggle = document.getElementById('notify-toggle') as HTMLButtonElement
const notifyBadge = document.getElementById('notify-badge') as HTMLSpanElement
const composePanel = document.getElementById('compose-panel') as HTMLDivElement
const composeTop = document.getElementById('compose-top') as HTMLDivElement
const composeChipLabel = document.getElementById('compose-chip-label') as HTMLSpanElement
const composeMode = document.getElementById('compose-mode') as HTMLSpanElement
const composeText = document.getElementById('compose-text') as HTMLTextAreaElement
const composeProject = document.getElementById('compose-project') as HTMLSelectElement
const composeModel = document.getElementById('compose-model') as HTMLSpanElement
const composeSend = document.getElementById('compose-send') as HTMLButtonElement

/** Latest options the harness plugin has reported, or `undefined` before the first one arrives. */
let composerOptions: ComposerOptions | undefined

/** True once real workspace data has arrived — the signal to use `composeRich` and show the chip. */
function hasRichOptions(): boolean {
  return composerOptions !== undefined && composerOptions.workspaces.length > 0
}

/**
 * Fills the framing rows from the latest options: rebuilds the workspace
 * `<select>` and its visible chip label, and sets the two read-only labels
 * (mode above, model below). Mode and model are plain text with no picker —
 * the plugin decides them; the pet only shows them. Either is hidden when the
 * plugin didn't report it.
 */
function populateOptions(): void {
  const opts = composerOptions
  if (opts === undefined || opts.workspaces.length === 0) return
  composeProject.replaceChildren(
    ...opts.workspaces.map((w) => {
      const opt = document.createElement('option')
      opt.value = w.id
      opt.textContent = w.title
      if (w.current) opt.selected = true
      return opt
    }),
  )
  const current = opts.workspaces.find((w) => w.id === composeProject.value) ?? opts.workspaces[0]
  composeChipLabel.textContent = current.title

  const mode = opts.currentMode?.trim() ?? ''
  composeMode.textContent = mode
  composeMode.hidden = mode === ''
  const model = opts.currentModel?.trim() ?? ''
  composeModel.textContent = model
  composeModel.hidden = model === ''
}

/**
 * Grows the input from one line toward its CSS `max-height` as the message
 * lengthens — the harness composer's own single-line-that-grows feel. The
 * panel lives in a window sized for the tallest state (`petComposePanelSize`
 * in `src/main/pet-window.ts`), so growth never clips; past the cap the
 * textarea scrolls. Setting height to `auto` first lets it shrink back as
 * text is deleted, not only grow.
 */
function autoGrowInput(): void {
  composeText.style.height = 'auto'
  composeText.style.height = `${String(composeText.scrollHeight)}px`
}

// The transparent `<select>` sits over the chip so a click opens the native
// picker; keep the visible label in sync with whatever the user picks.
composeProject.addEventListener('change', () => {
  const chosen = composerOptions?.workspaces.find((w) => w.id === composeProject.value)
  if (chosen !== undefined) composeChipLabel.textContent = chosen.title
})

function openCompose(): void {
  window.pet.setComposeOpen(true)
  const rich = hasRichOptions()
  if (rich) populateOptions()
  // The framing rows (workspace + mode) belong to the rich path only; the
  // plain fallback is just the input and its send button.
  composeTop.hidden = !rich
  composePanel.hidden = false
  // The panel takes the controls row's own slot rather than growing past
  // it — see the `body.composing #pet-controls` rule in pet.html — so the
  // sprite above never shifts when the panel opens or closes.
  document.body.classList.add('composing')
  composeText.focus()
  autoGrowInput()
}

function closeCompose(): void {
  composeText.value = ''
  composeText.style.height = ''
  composePanel.hidden = true
  document.body.classList.remove('composing')
  window.pet.setComposeOpen(false)
}

function submitCompose(): void {
  const text = composeText.value.trim()
  if (text !== '') {
    if (hasRichOptions()) {
      const req: ComposeRequest = {
        text,
        workspaceId: composeProject.value === '' ? undefined : composeProject.value,
        send: true,
      }
      window.pet.composeRich(req)
    } else {
      window.pet.compose(text)
    }
  }
  closeCompose()
}

// Keep focus on the panel while the pencil is pressed: without this the panel's
// own blur-out (below) fires on the toggle's mousedown and closes it just before
// the click handler runs, so the pencil could only ever open, never close it.
composeToggle.addEventListener('mousedown', (e) => e.preventDefault())
composeToggle.addEventListener('click', () => {
  if (composePanel.hidden) openCompose()
  else closeCompose()
})

// The bell is "see the finished turn": bring the harness forward, which
// already clears the badge on the main side (see onState's next `badge:false`).
notifyToggle.addEventListener('click', () => window.pet.activate())

// Enter sends, Shift+Enter is a newline, Escape closes. Blur closes it too,
// but only once focus has actually left the panel — moving focus between the
// textarea and the workspace select is not "clicking away".
composePanel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeCompose()
  } else if (e.key === 'Enter' && e.target === composeText && !e.shiftKey) {
    e.preventDefault()
    submitCompose()
  }
})
composePanel.addEventListener('focusout', (e) => {
  const next = e.relatedTarget
  if (next instanceof Node && composePanel.contains(next)) return
  closeCompose()
})
composeSend.addEventListener('click', () => submitCompose())
composeText.addEventListener('input', autoGrowInput)

window.pet.onComposerOptions((opts) => {
  composerOptions = opts
})

resize()
requestAnimationFrame(draw)
