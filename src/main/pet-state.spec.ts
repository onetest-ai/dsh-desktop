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

  it('settles a mid-wave disable to idle, so re-enabling does not replay the wave', () => {
    const { m, emitted } = make(true)
    m.onHook('turn-end')
    expect(emitted.at(-1)?.state).toBe('wave')
    m.setEnabled(false)
    m.setEnabled(true)
    expect(emitted.at(-1)).toEqual({ state: 'idle', badge: false })
    // No wave timer survived the disable to fire late and re-wave.
    vi.advanceTimersByTime(WAVE_MS)
    expect(emitted.at(-1)).toEqual({ state: 'idle', badge: false })
  })

  it('onEvent carries bubble text', () => {
    const { m, emitted } = make()
    m.onEvent({ state: 'running', text: 'Reading x' })
    expect(emitted.at(-1)).toEqual({ state: 'running', badge: false, text: 'Reading x' })
  })

  it('onEvent does not re-emit an identical consecutive state+text', () => {
    const { m, emitted } = make()
    m.onEvent({ state: 'running', text: 'Reading x' })
    m.onEvent({ state: 'running', text: 'Reading x' })
    expect(emitted.filter((e) => e.state === 'running')).toHaveLength(1)
  })

  it('onEvent re-emits when only the text changes', () => {
    const { m, emitted } = make()
    m.onEvent({ state: 'running', text: 'Reading x' })
    m.onEvent({ state: 'running', text: 'Reading y' })
    expect(emitted.map((e) => e.text)).toEqual([undefined, 'Reading x', 'Reading y'])
  })

  it('onEvent with a duration auto-reverts to idle with no text', () => {
    const { m, emitted } = make()
    m.onEvent({ state: 'running', text: 'Reading x', duration: 500 })
    vi.advanceTimersByTime(500)
    expect(emitted.at(-1)).toEqual({ state: 'idle', badge: false, text: undefined })
  })

  it('onEvent with no duration does not auto-revert', () => {
    const { m, emitted } = make()
    m.onEvent({ state: 'waiting', text: 'Stuck' })
    vi.advanceTimersByTime(WAVE_MS * 10)
    expect(emitted.at(-1)).toEqual({ state: 'waiting', badge: false, text: 'Stuck' })
  })

  it('a later onEvent cancels a pending duration revert', () => {
    const { m, emitted } = make()
    m.onEvent({ state: 'running', text: 'Reading x', duration: 500 })
    m.onEvent({ state: 'waiting', text: 'Blocked' })
    vi.advanceTimersByTime(500)
    expect(emitted.at(-1)).toEqual({ state: 'waiting', badge: false, text: 'Blocked' })
  })

  it('a wave via onEvent auto-reverts to idle after WAVE_MS', () => {
    const { m, emitted } = make(true)
    m.onEvent({ state: 'wave', text: 'Done.' })
    expect(emitted.at(-1)).toEqual({ state: 'wave', badge: false, text: 'Done.' })
    vi.advanceTimersByTime(WAVE_MS)
    expect(emitted.at(-1)).toEqual({ state: 'idle', badge: false, text: undefined })
  })

  it('a wave via onEvent badges a missed turn when the harness is unfocused', () => {
    const { m, emitted } = make(false)
    m.onEvent({ state: 'wave', text: 'Done.' })
    expect(emitted.at(-1)).toEqual({ state: 'wave', badge: true, text: 'Done.' })
    vi.advanceTimersByTime(WAVE_MS)
    // The wave settles to idle but the badge persists until the pet is opened.
    expect(emitted.at(-1)).toEqual({ state: 'idle', badge: true, text: undefined })
  })
})
