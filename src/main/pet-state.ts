import type { HookKind } from './notify'

export type PetDriveState = 'idle' | 'running' | 'waiting' | 'wave'
export interface PetSnapshot {
  state: PetDriveState
  badge: boolean
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
  let badge = false
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
    if (last !== undefined && last.state === state && last.badge === badge) return
    last = { state, badge }
    deps.emit(last)
  }

  const set = (next: PetDriveState): void => {
    state = next
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
