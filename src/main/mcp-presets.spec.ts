import { describe, expect, it } from 'vitest'
import { findPreset, MCP_PRESETS, selectablePresets } from './mcp-presets'

describe('MCP_PRESETS', () => {
  it('gives every preset a unique id', () => {
    const ids = MCP_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reaches every preset over https', () => {
    for (const preset of MCP_PRESETS) expect(preset.url.startsWith('https://')).toBe(true)
  })

  it('names the credential of every preset that takes one, and of no other', () => {
    for (const preset of MCP_PRESETS) {
      expect(preset.tokenLabel !== undefined).toBe(preset.auth === 'token')
    }
  })
})

describe('findPreset', () => {
  it('finds a declared preset', () => {
    expect(findPreset('tavily')?.url).toBe('https://mcp.tavily.com/mcp/')
  })

  it('returns undefined for an id no row declares', () => {
    expect(findPreset('nope')).toBeUndefined()
  })
})

describe('selectablePresets', () => {
  it('offers exactly the presets that issue a pasteable credential', () => {
    expect(selectablePresets().map((preset) => preset.id)).toEqual(['tavily', 'github'])
  })

  it('leaves the OAuth-only presets out, so they cannot be added with a token', () => {
    const offered = new Set(selectablePresets().map((preset) => preset.id))
    for (const preset of MCP_PRESETS.filter((candidate) => candidate.auth === 'oauth')) {
      expect(offered.has(preset.id)).toBe(false)
    }
  })
})
