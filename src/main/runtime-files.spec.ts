import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPackageLoadable, hooksConfig, patchOverlay, writeRuntimeFiles, type LoadabilityProbe } from './runtime-files'

/** Always reports the bridge as loadable, regardless of `fromDirectory`. */
const alwaysLoadable: LoadabilityProbe = () => undefined

/** Always reports the bridge as unloadable, with a fixed reason. */
const alwaysUnloadable: LoadabilityProbe = () => 'package not found'

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
  it('mounts the hook bridge against the generated hook config when no reason is given', () => {
    const overlay = patchOverlay("/tmp/o'brien/hooks.json")
    expect(overlay).toContain("configPath: '/tmp/o''brien/hooks.json'")
    expect(overlay).toContain("name: '@deepseek-ai/dsh-hooks-claude-code'")
    expect(overlay).toContain('port: 0')
  })

  it('omits the insert and records the reason as a comment when the bridge is unloadable', () => {
    const overlay = patchOverlay('/tmp/hooks.json', "cannot find package 'x'")
    expect(overlay).not.toContain('insert')
    expect(overlay).not.toContain("name: '@deepseek-ai/dsh-hooks-claude-code'")
    expect(overlay).toContain("was omitted: cannot find package 'x'")
    expect(overlay).toContain('port: 0')
  })
})

describe('checkPackageLoadable', () => {
  it('never throws, even from a nonexistent directory', () => {
    expect(() => checkPackageLoadable('@deepseek-ai/dsh-hooks-claude-code', '/does/not/exist')).not.toThrow()
  })

  it('reports a reason when the package itself is not resolvable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
    const reason = checkPackageLoadable('@deepseek-ai/dsh-hooks-claude-code', directory)
    expect(reason).toBeDefined()
  })
})

describe('writeRuntimeFiles', () => {
  it('includes the insert when the bridge is loadable', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(directory, 44001, '/irrelevant', alwaysLoadable)

    expect(files.hooksOmittedReason).toBeUndefined()
    expect(files.patchPath).toBe(join(directory, 'desktop.patch.yml'))
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).toContain(`configPath: '${files.hooksPath}'`)
    expect(overlay).toContain('port: 0')
    expect(readFileSync(files.hooksPath, 'utf8')).toContain('127.0.0.1:44001')
  })

  it('omits the insert and reports a reason when the bridge is not loadable', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(directory, 44001, '/irrelevant', alwaysUnloadable)

    expect(files.hooksOmittedReason).toBe('package not found')
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).not.toContain('insert')
    expect(overlay).toContain('was omitted: package not found')
    // The webserver pin is present either way.
    expect(overlay).toContain('port: 0')
  })

  it('rewrites the port when the configuration changes', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    writeRuntimeFiles(directory, 44001, '/irrelevant', alwaysLoadable)
    const files = writeRuntimeFiles(directory, 44002, '/irrelevant', alwaysLoadable)
    expect(readFileSync(files.hooksPath, 'utf8')).toContain('127.0.0.1:44002')
  })
})
