import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hooksConfig, patchOverlay, writeRuntimeFiles } from './runtime-files'

describe('hooksConfig', () => {
  it('points the Stop hook at the configured notification port', () => {
    const parsed = JSON.parse(hooksConfig(51999))
    const command = parsed.hooks.Stop[0].hooks[0].command
    expect(command).toContain('http://127.0.0.1:51999/turn-end')
  })

  it('keeps the Stop hook non-blocking: silenced, bounded, and always exit 0', () => {
    const command = JSON.parse(hooksConfig(1234)).hooks.Stop[0].hooks[0].command
    // A Stop hook's stdout is fed back to the agent as steering, and a failure
    // would surface as a hook error, so both are suppressed unconditionally.
    expect(command).toContain('> /dev/null 2>&1')
    expect(command.trimEnd().endsWith('|| true')).toBe(true)
    expect(command).toContain('-m 2')
  })
})

describe('patchOverlay', () => {
  it('mounts the hook bridge against the generated hook config', () => {
    const overlay = patchOverlay("/tmp/o'brien/hooks.json")
    expect(overlay).toContain("configPath: '/tmp/o''brien/hooks.json'")
    expect(overlay).toContain("name: '@deepseek-ai/dsh-hooks-claude-code'")
    expect(overlay).toContain('port: 0')
  })
})

describe('writeRuntimeFiles', () => {
  it('generates both files into a directory it creates, cross-linked by absolute path', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(directory, 44001)

    expect(files.patchPath).toBe(join(directory, 'desktop.patch.yml'))
    expect(readFileSync(files.patchPath, 'utf8')).toContain(`configPath: '${files.hooksPath}'`)
    expect(readFileSync(files.hooksPath, 'utf8')).toContain('127.0.0.1:44001')
  })

  it('rewrites the port when the configuration changes', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    writeRuntimeFiles(directory, 44001)
    const files = writeRuntimeFiles(directory, 44002)
    expect(readFileSync(files.hooksPath, 'utf8')).toContain('127.0.0.1:44002')
  })
})
