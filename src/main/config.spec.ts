import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, contents)
  return file
}

describe('loadConfig', () => {
  it('reads harnessRepo and applies defaults for the rest', () => {
    const file = writeConfig(JSON.stringify({ harnessRepo: '/tmp/harness' }))
    expect(loadConfig(file)).toEqual({
      harnessRepo: '/tmp/harness',
      notifyPort: 43117,
      hotkey: 'CommandOrControl+Shift+D',
    })
  })

  it('keeps explicit overrides', () => {
    const file = writeConfig(
      JSON.stringify({ harnessRepo: '/tmp/h', notifyPort: 5000, hotkey: 'Alt+D' }),
    )
    const config = loadConfig(file)
    expect(config.notifyPort).toBe(5000)
    expect(config.hotkey).toBe('Alt+D')
  })

  it('throws a message naming the file when harnessRepo is missing', () => {
    const file = writeConfig(JSON.stringify({}))
    expect(() => loadConfig(file)).toThrow(/harnessRepo/)
    expect(() => loadConfig(file)).toThrow(file)
  })

  it('throws a message naming the file when the JSON is malformed', () => {
    const file = writeConfig('{ not json')
    expect(() => loadConfig(file)).toThrow(file)
  })
})
