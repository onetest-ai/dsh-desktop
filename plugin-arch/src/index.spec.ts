import { describe, expect, it } from 'vitest'
import { apply, inject } from './index.ts'

describe('apply', () => {
  it('is a cordis plugin body', () => {
    expect(typeof apply).toBe('function')
  })
})

describe('inject', () => {
  it('declares every service the plugin reaches, including the indirect one', () => {
    expect(inject).toEqual(['connection', 'webServer', 'workspaceRegistry', 'tools'])
  })

  it('declares webServer even though no code here names it', () => {
    // This array entry alone will not save you: `ctx.connection.rpc`'s getter
    // captures the context the SERVICE is bound to, not this fiber, so the
    // module-level inject below does not reach it — `apply`'s
    // `ctx.inject(['webServer'], …)` scoped registration is the part that
    // actually makes the harness boot. Keeping this entry here is still
    // correct (it is an accurate statement of what this plugin depends on,
    // and it makes the fiber wait for the service rather than racing it), but
    // dropping the scoped call in `apply` while leaving this entry in place
    // would pass every unit test here and still fail to boot.
    expect(inject).toContain('webServer')
  })
})
