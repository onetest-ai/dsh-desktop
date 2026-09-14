import { describe as suite, it, expect } from 'vitest'

// pet-hook.mjs is a standalone ESM script (Node stdlib only, no bundling) that
// runs under the harness's node — importing it here as plain ESM exercises the
// same module vitest would load anywhere else, no .d.ts needed since this spec
// is excluded from tsconfig.json's typecheck (see tsconfig.json's `exclude`).
const hookModule = await import('./runtime/pet-hook.mjs')
const { describe, buildBody } = hookModule

suite('pet-hook buildBody', () => {
  it('tool Read with a file_path → running, "Reading <basename>"', () => {
    expect(buildBody('tool', { tool_name: 'Read', tool_input: { file_path: '/a/auth.ts' } })).toEqual({
      state: 'running',
      text: 'Reading auth.ts',
    })
  })

  it('notify → waiting, "Waiting for you…"', () => {
    expect(buildBody('notify', {})).toEqual({ state: 'waiting', text: 'Waiting for you…' })
  })

  it('stop → wave, "Done."', () => {
    expect(buildBody('stop', {})).toEqual({ state: 'wave', text: 'Done.' })
  })

  it('malformed json (a string instead of an object) falls back to a safe default body, never throws', () => {
    expect(() => buildBody('tool', 'not json' as unknown as Record<string, unknown>)).not.toThrow()
    expect(buildBody('tool', 'not json' as unknown as Record<string, unknown>)).toEqual({
      state: 'running',
      text: 'Calling tool',
    })
  })

  it('unparseable stdin represented as {} still yields a safe body per event', () => {
    expect(buildBody('error', {})).toEqual({ state: 'failed', text: 'Tool failed' })
  })
})

suite('pet-hook describe (re-exported templater, mirrors pet-bubble.ts)', () => {
  it('prompt → jumping, "Thinking…"', () => {
    expect(describe('prompt')).toEqual({ state: 'jumping', text: 'Thinking…' })
  })

  it('tool-done Edit → running, "Editing <basename>"', () => {
    expect(describe('tool-done', { tool_name: 'Edit', tool_input: { file_path: '/a/b/main.ts' } })).toEqual({
      state: 'running',
      text: 'Editing main.ts',
    })
  })
})
