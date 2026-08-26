import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPresets, shippedPresetsPath, userPresetsPath } from './mcp-presets'

/** Write a catalog file and return its path; omit content for an absent file. */
function catalog(content?: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-presets-')), 'mcp-presets.json')
  if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

const TAVILY = { id: 'tavily', label: 'Tavily', transport: 'http', url: 'https://mcp.tavily.com/mcp/', auth: 'token' }
const PLAYWRIGHT = { id: 'playwright', label: 'Playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }

describe('userPresetsPath', () => {
  it('sits beside mcp.json under the harness home', () => {
    expect(userPresetsPath('/home/.dsh')).toBe('/home/.dsh/mcp-presets.json')
  })
})

describe('loadPresets', () => {
  it('loads the shipped catalog', () => {
    expect(loadPresets(catalog({ presets: [TAVILY] }), catalog()).map((p) => p.id)).toEqual(['tavily'])
  })

  it('loads stdio presets, not only http ones', () => {
    expect(loadPresets(catalog({ presets: [PLAYWRIGHT] }), catalog())[0]).toMatchObject({ transport: 'stdio', command: 'npx' })
  })

  it('lets a user file add a preset, which is the point of not hardcoding these', () => {
    const loaded = loadPresets(catalog({ presets: [TAVILY] }), catalog({ presets: [PLAYWRIGHT] }))
    expect(loaded.map((p) => p.id).sort()).toEqual(['playwright', 'tavily'])
  })

  it('lets a user file correct a shipped preset by id, without an app release', () => {
    const fixed = { ...TAVILY, url: 'https://mcp.tavily.com/v2/' }
    const loaded = loadPresets(catalog({ presets: [TAVILY] }), catalog({ presets: [fixed] }))
    expect(loaded.find((p) => p.id === 'tavily')?.url).toBe('https://mcp.tavily.com/v2/')
  })

  it('keeps the shipped catalog when there is no user file', () => {
    expect(loadPresets(catalog({ presets: [TAVILY] }), catalog()).map((p) => p.id)).toEqual(['tavily'])
  })

  it('skips an invalid entry rather than losing the whole catalog', () => {
    expect(loadPresets(catalog({ presets: [TAVILY, { id: 'broken' }] }), catalog()).map((p) => p.id)).toEqual(['tavily'])
  })

  it('skips an http preset that is not https, which would leak a token', () => {
    const bad = { ...TAVILY, id: 'bad', url: 'http://x.example/mcp' }
    expect(loadPresets(catalog({ presets: [bad] }), catalog())).toEqual([])
  })

  it('skips a stdio preset with no command', () => {
    expect(loadPresets(catalog({ presets: [{ ...PLAYWRIGHT, command: undefined }] }), catalog())).toEqual([])
  })

  it('survives a malformed user file, since a hand edit can go wrong', () => {
    expect(loadPresets(catalog({ presets: [TAVILY] }), catalog('{ oops')).map((p) => p.id)).toEqual(['tavily'])
  })

  it('survives a malformed shipped catalog rather than failing to start', () => {
    expect(loadPresets(catalog('nonsense'), catalog())).toEqual([])
  })
})

describe('the catalog this app actually ships', () => {
  it('parses and is non-empty, which no compiler checks any more', () => {
    expect(loadPresets(shippedPresetsPath(), catalog()).length).toBeGreaterThan(0)
  })

  it('gives every shipped preset a unique id', () => {
    const ids = loadPresets(shippedPresetsPath(), catalog()).map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reaches every http preset over https, since a token travels there', () => {
    for (const preset of loadPresets(shippedPresetsPath(), catalog())) {
      if (preset.transport === 'http') expect(preset.url?.startsWith('https://')).toBe(true)
    }
  })

  it('says why every unusable preset is unusable, so the picker can explain itself', () => {
    for (const preset of loadPresets(shippedPresetsPath(), catalog())) {
      if (preset.auth === 'oauth') expect(preset.unavailable).toBeTruthy()
    }
  })

  it('offers stdio servers, which is what this catalog was extended for', () => {
    expect(loadPresets(shippedPresetsPath(), catalog()).some((p) => p.transport === 'stdio')).toBe(true)
  })
})
