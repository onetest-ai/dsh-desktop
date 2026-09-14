import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPetState, WAVE_MS, type PetSnapshot } from './pet-state'

describe('pet-state', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (focused = true) => {
    const emitted: PetSnapshot[] = []
    const m = createPetState({ emit: (s) => emitted.push({ ...s }), isHarnessFocused: () => focused })
    m.setEnabled(true)
    return { m, emitted }
  }

  it('emits idle on enable', () => {
    const { emitted } = make()
    expect(emitted).toEqual([{ state: 'idle', badge: false }])
  })

  it('prompt/tool -> running, notify -> waiting', () => {
    const { m, emitted } = make()
    m.onHook('prompt')
    m.onHook('tool') // deduped
    m.onHook('notify')
    expect(emitted.map((e) => e.state)).toEqual(['idle', 'running', 'waiting'])
  })

  it('turn-end waves then returns to idle after WAVE_MS', () => {
    const { m, emitted } = make(true)
    m.onHook('prompt')
    m.onHook('turn-end')
    vi.advanceTimersByTime(WAVE_MS)
    expect(emitted.map((e) => e.state)).toEqual(['idle', 'running', 'wave', 'idle'])
    expect(emitted.every((e) => e.badge === false)).toBe(true)
  })

  it('sets a badge when the turn ends while the harness is unfocused', () => {
    const { m, emitted } = make(false)
    m.onHook('turn-end')
    expect(emitted.at(-1)).toEqual({ state: 'wave', badge: true })
    vi.advanceTimersByTime(WAVE_MS)
    expect(emitted.at(-1)).toEqual({ state: 'idle', badge: true })
  })

  it('clearBadge clears it', () => {
    const { m, emitted } = make(false)
    m.onHook('turn-end')
    m.clearBadge()
    expect(emitted.at(-1)?.badge).toBe(false)
  })

  it('a new prompt cancels the pending wave->idle', () => {
    const { m, emitted } = make(true)
    m.onHook('turn-end')
    m.onHook('prompt')
    vi.advanceTimersByTime(WAVE_MS)
    expect(emitted.map((e) => e.state)).toEqual(['idle', 'wave', 'running'])
  })

  it('does not emit while disabled', () => {
    const emitted: PetSnapshot[] = []
    const m = createPetState({ emit: (s) => emitted.push(s), isHarnessFocused: () => true })
    m.onHook('prompt')
    expect(emitted).toEqual([])
  })
})
