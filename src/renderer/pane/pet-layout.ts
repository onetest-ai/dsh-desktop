/**
 * The Petdex sprite atlas is a fixed convention, not data carried in `pet.json`
 * (which holds only id/displayName/description/spriteVersionNumber/spritesheetPath).
 * Every pet's frames are 192×208, laid out 8 columns wide; each row is one state.
 * Row order and frame counts are Petdex's own (src/lib/pet-states.ts): they are
 * the same for the v1 (9-row) and v2 (11-row) sheets, so we key nothing off the
 * version here. Re-declared renderer-side because the pane never imports from main.
 */
export type PetStateId =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

/** The subset of states the main-process state machine drives in v1. */
export type PetDriveState = 'idle' | 'running' | 'waiting' | 'wave'

export const FRAME_W = 192
export const FRAME_H = 208
export const COLS = 8

export interface PetStateDef {
  row: number
  frames: number
  loopMs: number
}

export const PET_LAYOUT: Record<PetStateId, PetStateDef> = {
  idle: { row: 0, frames: 6, loopMs: 1100 },
  'running-right': { row: 1, frames: 8, loopMs: 1060 },
  'running-left': { row: 2, frames: 8, loopMs: 1060 },
  waving: { row: 3, frames: 4, loopMs: 700 },
  jumping: { row: 4, frames: 5, loopMs: 840 },
  failed: { row: 5, frames: 8, loopMs: 1220 },
  waiting: { row: 6, frames: 6, loopMs: 1010 },
  running: { row: 7, frames: 6, loopMs: 820 },
  review: { row: 8, frames: 6, loopMs: 1030 },
}

export const DRIVE_TO_STATE: Record<PetDriveState, PetStateId> = {
  idle: 'idle',
  running: 'running',
  waiting: 'waiting',
  wave: 'waving',
}

/** Source rectangle into the spritesheet for the frame shown at `elapsedMs`. */
export function frameAt(state: PetStateId, elapsedMs: number): { sx: number; sy: number; sw: number; sh: number } {
  const def = PET_LAYOUT[state]
  const per = def.loopMs / def.frames
  const col = Math.floor((elapsedMs % def.loopMs) / per) % def.frames
  return { sx: col * FRAME_W, sy: def.row * FRAME_H, sw: FRAME_W, sh: FRAME_H }
}

/**
 * Vertical room reserved above the sprite for the speech bubble. The window
 * is `FRAME_H + BUBBLE_BAND` tall (see `petWindowSize` in
 * `src/main/pet-window.ts`, kept equal to this by hand — the pane never
 * imports from main); the sprite still paints in the lower `FRAME_H` band so
 * it visually sits exactly where it did before the bubble existed.
 */
export const BUBBLE_BAND = 96

/** Mirrors `MAX_TEXT_LENGTH` in `src/main/pet-bubble.ts` — main already
 * truncates bubble text to this before sending; this is a defensive backstop
 * so a future caller of `bubbleLayout` can't blow past it either. */
export const BUBBLE_MAX_CHARS = 40

const BUBBLE_PAD_X = 10
const BUBBLE_PAD_Y = 6
/** A monospace-ish per-character width estimate. There is no canvas to
 * measure against here — `bubbleLayout` stays a pure, unit-testable helper —
 * so this trades exact text metrics for a width bound that's cheap to check. */
const BUBBLE_CHAR_W = 6.2
const BUBBLE_LINE_H = 16

export interface BubbleLayoutResult {
  /** The text to actually paint — truncated to `BUBBLE_MAX_CHARS`, then further if it still overflows `maxWidthPx`. */
  text: string
  rectW: number
  rectH: number
}

/**
 * Sizes the speech-bubble rectangle for `text` within `maxWidthPx`. Truncates
 * with an ellipsis first to `BUBBLE_MAX_CHARS` characters, then again if the
 * estimated pixel width still doesn't fit `maxWidthPx`.
 */
export function bubbleLayout(text: string, maxWidthPx: number): BubbleLayoutResult {
  const capped = text.length > BUBBLE_MAX_CHARS ? `${text.slice(0, BUBBLE_MAX_CHARS - 1)}…` : text
  const innerMax = Math.max(BUBBLE_CHAR_W, maxWidthPx - BUBBLE_PAD_X * 2)
  const maxChars = Math.max(1, Math.floor(innerMax / BUBBLE_CHAR_W))
  const fitted = capped.length > maxChars ? `${capped.slice(0, Math.max(1, maxChars - 1))}…` : capped
  const rectW = Math.min(maxWidthPx, fitted.length * BUBBLE_CHAR_W + BUBBLE_PAD_X * 2)
  const rectH = BUBBLE_LINE_H + BUBBLE_PAD_Y * 2
  return { text: fitted, rectW, rectH }
}
