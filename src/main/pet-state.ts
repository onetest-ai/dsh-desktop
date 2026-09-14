import type { HookKind } from './notify'

/**
 * 'idle' | 'running' | 'waiting' | 'wave' are the v1 set driven by `onHook`.
 * 'jumping' | 'failed' | 'review' are richer states the hook-script templater
 * (A7) emits over `onEvent` once a task's outcome is known; the state machine
 * doesn't interpret them, it just carries and dedupes whatever it's given.
 */
export type PetDriveState = 'idle' | 'running' | 'waiting' | 'wave' | 'jumping' | 'failed' | 'review'
export interface PetSnapshot {
  state: PetDriveState
  badge: boolean
  /** Bubble copy for the pet window, e.g. "Reading auth.ts" or "Done." Absent hides the bubble. */
  text?: string
}
export interface PetStateDeps {
  emit: (snap: PetSnapshot) => void
  isHarnessFocused: () => boolean
  now?: () => number
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}
export interface PetStateMachine {
  onHook: (kind: HookKind) => void
  /**
   * The richer path: a templated hook event carries its own state and bubble
   * text directly, plus an optional auto-revert `duration` (ms) — the same
   * idea as the wave timer, generalized so a caller doesn't have to know
   * WAVE_MS is specific to waving.
   */
  onEvent: (e: { state: PetDriveState; text?: string; duration?: number }) => void
  setEnabled: (on: boolean) => void
  clearBadge: () => void
  dispose: () => void
}

/**
 * How long the wave plays before the pet settles back to idle. Two loops of the
 * 700ms waving row read as a deliberate greeting rather than a twitch.
 */
export const WAVE_MS = 1400

/**
 * The single source of truth for the pet's animation state.
 *
 * Every harness activity hook (routed by `notify.ts`) and the harness-focus
 * question funnel through here and out as one deduped snapshot, so the pet
 * window is a pure puppet of this machine — no state lives in the renderer.
 */
export function createPetState(deps: PetStateDeps): PetStateMachine {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle))

  let enabled = false
  let state: PetDriveState = 'idle'
  let text: string | undefined
  let badge = false
  // Named for its v1 origin (the wave->idle timer) but now doubles as the
  // generic auto-revert timer for any onEvent(duration) — there is only ever
  // one pending revert at a time, so one handle covers both.
  let waveTimer: ReturnType<typeof setTimeout> | undefined
  let last: PetSnapshot | undefined

  const clearWave = (): void => {
    if (waveTimer !== undefined) {
      cancel(waveTimer)
      waveTimer = undefined
    }
  }

  const push = (): void => {
    if (!enabled) return
    if (last !== undefined && last.state === state && last.badge === badge && last.text === text) return
    last = { state, badge, text }
    deps.emit(last)
  }

  const set = (next: PetDriveState, nextText?: string): void => {
    state = next
    text = nextText
    push()
  }

  return {
    onHook(kind: HookKind): void {
      if (kind !== 'turn-end') clearWave()
      switch (kind) {
        case 'prompt':
        case 'tool':
          set('running')
          break
        case 'notify':
          set('waiting')
          break
        case 'turn-end':
          if (!deps.isHarnessFocused()) badge = true
          set('wave')
          clearWave()
          waveTimer = schedule(() => {
            waveTimer = undefined
            set('idle')
          }, WAVE_MS)
          break
      }
    },
    onEvent(e): void {
      clearWave()
      // A wave carries the v1 turn-end semantics even when it arrives templated
      // over onEvent (the Stop hook now POSTs {state:'wave'} rather than hitting
      // /turn-end): raise the missed-turn badge when the harness is unfocused,
      // and auto-revert to idle after WAVE_MS. Set the badge before `set` so the
      // emitted snapshot already carries it.
      if (e.state === 'wave' && !deps.isHarnessFocused()) badge = true
      set(e.state, e.text)
      // A wave reverts on the fixed WAVE_MS; any other state reverts only if the
      // caller asked for a duration (the generalized auto-revert from A5).
      const revertMs = e.state === 'wave' ? WAVE_MS : e.duration !== undefined && e.duration > 0 ? e.duration : undefined
      if (revertMs !== undefined) {
        waveTimer = schedule(() => {
          waveTimer = undefined
          set('idle')
        }, revertMs)
      }
    },
    setEnabled(on: boolean): void {
      enabled = on
      if (on) {
        last = undefined
        push()
      } else {
        clearWave()
        // Settle a mid-wave disable back to idle so a later re-enable emits
        // idle rather than replaying a stale 'wave' with no timer left to
        // bring it back down.
        state = 'idle'
        text = undefined
      }
    },
    clearBadge(): void {
      badge = false
      push()
    },
    dispose(): void {
      clearWave()
      enabled = false
    },
  }
}
