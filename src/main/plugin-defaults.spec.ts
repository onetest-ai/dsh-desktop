import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PLUGIN_SPECS, DEFAULTS_GENERATION, ensureDefaultPlugins, PROJECT_MCP_BRIDGE } from './plugin-defaults'
import { parseSpec } from './plugin-entries'

/** A home holding a desktop.json with the given fields. */
function home(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-defaults-'))
  writeFileSync(join(dir, 'desktop.json'), JSON.stringify({ harness: { kind: 'local', repo: '/tmp' }, ...config }))
  return dir
}

/** The stored config, re-read. */
function stored(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))
}

/** The package names in the stored plugin list. */
function specs(dir: string): string[] {
  return ((stored(dir).plugins ?? []) as { spec: string }[]).map((entry) => entry.spec)
}

describe('ensureDefaultPlugins', () => {
  it('adds the per-project MCP bridge to an install that predates it', () => {
    const dir = home({ plugins: [{ spec: '@deepseek-ai/dsh-hooks-claude-code', version: '0.1.1' }] })
    expect(ensureDefaultPlugins(dir)).toBe(true)
    expect(specs(dir)).toContain(PROJECT_MCP_BRIDGE)
  })

  it('does not add a default the user already has, under any version', () => {
    const dir = home({ plugins: [{ spec: 'dsh-project-mcp-bridge@0.1.0', version: '0.1.0' }] })
    ensureDefaultPlugins(dir)
    expect(specs(dir)).not.toContain(PROJECT_MCP_BRIDGE)
    expect(specs(dir)).toContain('dsh-project-mcp-bridge@0.1.0')
  })

  it('pins whatever it ships, so an unaudited package cannot change under the user', () => {
    expect(PROJECT_MCP_BRIDGE).toMatch(/@\d+\.\d+\.\d+$/)
  })

  it('keeps the plugins already configured', () => {
    const dir = home({ plugins: [{ spec: '@onetest/dsh-deck', version: '0.2.2' }] })
    ensureDefaultPlugins(dir)
    expect(specs(dir)).toContain('@onetest/dsh-deck')
  })

  it('records the generation, so it runs once rather than on every launch', () => {
    const dir = home({ plugins: [] })
    ensureDefaultPlugins(dir)
    expect(stored(dir).pluginDefaultsGeneration).toBe(DEFAULTS_GENERATION)
  })

  it('is a no-op the second time', () => {
    const dir = home({ plugins: [] })
    expect(ensureDefaultPlugins(dir)).toBe(true)
    expect(ensureDefaultPlugins(dir)).toBe(false)
  })

  it('never reinstates a default the user deliberately removed', () => {
    const dir = home({ plugins: [], pluginDefaultsGeneration: DEFAULTS_GENERATION })
    expect(ensureDefaultPlugins(dir)).toBe(false)
    expect(specs(dir)).toEqual([])
  })

  it('does nothing on a first run, where there is no config to migrate', () => {
    expect(ensureDefaultPlugins(mkdtempSync(join(tmpdir(), 'dsh-defaults-empty-')))).toBe(false)
  })

  it('leaves an unreadable config alone rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-defaults-bad-'))
    writeFileSync(join(dir, 'desktop.json'), 'not json')
    expect(ensureDefaultPlugins(dir)).toBe(false)
  })
})

describe('the default set', () => {
  // reason: adding a plugin to the set without raising the generation would
  // never reach an install that has already recorded the old one.
  it('raises the generation whenever the set grows', () => {
    expect(DEFAULTS_GENERATION).toBe(DEFAULT_PLUGIN_SPECS.length)
  })

  it('pins every default to an exact version', () => {
    for (const spec of DEFAULT_PLUGIN_SPECS) expect(parseSpec(spec).pinnedVersion).toBeDefined()
  })
})
