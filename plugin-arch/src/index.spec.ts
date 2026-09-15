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
    // `rpc.handle` registers its route via `owner.webServer.register(route)`,
    // on the caller's context. Dropping this from inject is a clean-looking
    // change that stops the harness booting.
    expect(inject).toContain('webServer')
  })
})
