import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateMcpConfig } from './mcp-migrate'

/** A home holding a legacy desktop.json, and optionally a legacy token store. */
function legacyHome(mcp: unknown, tokens?: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))
  writeFileSync(join(home, 'desktop.json'), JSON.stringify({ harness: { kind: 'local', repo: '/tmp' }, mcp }))
  if (tokens !== undefined) {
    writeFileSync(join(home, 'desktop-secrets.json'), JSON.stringify({ version: 1, tokens }))
  }
  return home
}

/** The migrated mcp.json, parsed. */
function migrated(home: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers
}

const TAVILY = { id: 'tavily', preset: 'tavily', url: 'https://mcp.tavily.com/mcp/', enabled: true }

describe('migrateMcpConfig', () => {
  it('turns a legacy server into an http entry', () => {
    const home = legacyHome({ enabled: true, servers: [TAVILY] })
    expect(migrateMcpConfig(home)).toBe(true)
    expect(migrated(home).tavily).toMatchObject({ type: 'http', url: 'https://mcp.tavily.com/mcp/' })
  })

  it('carries a stored token into the Authorization header it was always sent as', () => {
    const home = legacyHome({ enabled: true, servers: [TAVILY] }, { tavily: 'tvly-abc' })
    migrateMcpConfig(home)
    expect(migrated(home).tavily.headers).toEqual({ Authorization: 'Bearer tvly-abc' })
  })

  it('removes the mcp section from desktop.json, leaving the rest intact', () => {
    const home = legacyHome({ enabled: true, servers: [TAVILY] })
    migrateMcpConfig(home)
    const config = JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8'))
    expect(config.mcp).toBeUndefined()
    expect(config.harness).toEqual({ kind: 'local', repo: '/tmp' })
  })

  it('deletes the token store, which nothing reads any more', () => {
    const home = legacyHome({ enabled: true, servers: [TAVILY] }, { tavily: 'tvly-abc' })
    migrateMcpConfig(home)
    expect(existsSync(join(home, 'desktop-secrets.json'))).toBe(false)
  })

  it('disables a server whose own switch was off', () => {
    const home = legacyHome({ enabled: true, servers: [{ ...TAVILY, enabled: false }] })
    migrateMcpConfig(home)
    expect(migrated(home).tavily.disabled).toBe(true)
  })

  it('disables every server when the master switch was off, since mcp.json has no master switch', () => {
    const home = legacyHome({ enabled: false, servers: [TAVILY] })
    migrateMcpConfig(home)
    expect(migrated(home).tavily.disabled).toBe(true)
  })

  it('is a no-op the second time', () => {
    const home = legacyHome({ enabled: true, servers: [TAVILY] })
    expect(migrateMcpConfig(home)).toBe(true)
    expect(migrateMcpConfig(home)).toBe(false)
  })

  it('never overwrites an existing mcp.json, which is the source of truth afterwards', () => {
    const home = legacyHome({ enabled: true, servers: [TAVILY] })
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'node' } } }))
    expect(migrateMcpConfig(home)).toBe(false)
    expect(Object.keys(migrated(home))).toEqual(['mine'])
  })

  it('does nothing when there was never an mcp section', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-migrate-none-'))
    writeFileSync(join(home, 'desktop.json'), JSON.stringify({ harness: { kind: 'local', repo: '/tmp' } }))
    expect(migrateMcpConfig(home)).toBe(false)
    expect(existsSync(join(home, 'mcp.json'))).toBe(false)
  })

  it('does nothing when there is no config at all, which is a first run', () => {
    expect(migrateMcpConfig(mkdtempSync(join(tmpdir(), 'dsh-migrate-empty-')))).toBe(false)
  })

  it('ignores a token store in the superseded encrypted format, never sending ciphertext as a bearer', () => {
    const home = legacyHome({ enabled: true, servers: [TAVILY] })
    writeFileSync(join(home, 'desktop-secrets.json'), JSON.stringify({ tavily: 'YmFzZTY0Y2lwaGVy' }))
    migrateMcpConfig(home)
    expect(migrated(home).tavily.headers).toBeUndefined()
  })
})
