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
