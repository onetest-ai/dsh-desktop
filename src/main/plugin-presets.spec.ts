import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentPresetsRoot, ensurePluginPresets, reconcilePluginPresets } from './plugin-presets'

/** A fresh `$DSH_HOME`-shaped temp directory for one test. */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-desktop-presets-'))
}

/** Write a fake installed package directory with one or more presets under `presetsSubdir`. */
function installedPackageWithPresets(presetIds: string[], presetsSubdir = 'presets'): string {
  const packageDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-presets-pkg-'))
  for (const id of presetIds) {
    const dir = join(packageDir, presetsSubdir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'preset.yml'), `id: ${id}\n`)
    writeFileSync(join(dir, 'agent.cordis.yml'), 'plugins: []\n')
  }
  return packageDir
}

describe('ensurePluginPresets', () => {
  it('copies each declared preset into $DSH_HOME/.agent-presets/<id>', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageWithPresets(['deck-creator'])

    const kept = ensurePluginPresets(dshHome, pkg, packageDir, 'presets')

    expect(kept).toEqual(['deck-creator'])
    const dest = join(agentPresetsRoot(dshHome), 'deck-creator')
    expect(existsSync(join(dest, 'preset.yml'))).toBe(true)
    expect(existsSync(join(dest, 'agent.cordis.yml'))).toBe(true)
  })

  it('copies nothing for a package with no dsh.presets declaration', () => {
    // Simulated by the caller (`index.ts`) never invoking `ensurePluginPresets`
    // for such a package — `presetsDeclaration` returning undefined is what
    // gates the call. This test proves the other half: even when a package
    // happens to contain a `preset.yml`-shaped directory, nothing is copied
    // unless this function is actually invoked with a declared subdir.
    const dshHome = freshHome()
    const packageDir = installedPackageWithPresets(['deck-creator'], 'undeclared')

    // Only the declared subdir ('presets') is ever scanned; 'undeclared' is
    // never passed, so nothing under it is found.
    const kept = ensurePluginPresets(dshHome, '@onetest/dsh-deck', packageDir, 'presets')

    expect(kept).toEqual([])
    expect(existsSync(agentPresetsRoot(dshHome))).toBe(false)
  })

  it('never overwrites an existing directory the app did not write', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageWithPresets(['deck-creator'])

    // The user's own hand-authored preset of the same id.
    const dest = join(agentPresetsRoot(dshHome), 'deck-creator')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'preset.yml'), 'id: deck-creator\n# hand-authored\n')
    writeFileSync(join(dest, 'sentinel.txt'), 'do not touch')

    const kept = ensurePluginPresets(dshHome, pkg, packageDir, 'presets')

    expect(kept).toEqual([])
    // Non-vacuity: the sentinel only survives if this call genuinely skipped
    // the directory rather than replacing it.
    expect(existsSync(join(dest, 'sentinel.txt'))).toBe(true)
    expect(readFileSync(join(dest, 'preset.yml'), 'utf8')).toContain('hand-authored')
  })

  it('re-copies its own preset to pick up a version-bumped change', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDirV1 = installedPackageWithPresets(['deck-creator'])
    ensurePluginPresets(dshHome, pkg, packageDirV1, 'presets')

    const packageDirV2 = installedPackageWithPresets(['deck-creator'])
    writeFileSync(join(packageDirV2, 'presets', 'deck-creator', 'preset.yml'), 'id: deck-creator\nversion: 2\n')

    ensurePluginPresets(dshHome, pkg, packageDirV2, 'presets')

    const dest = join(agentPresetsRoot(dshHome), 'deck-creator')
    expect(readFileSync(join(dest, 'preset.yml'), 'utf8')).toContain('version: 2')
  })
})

describe('reconcilePluginPresets', () => {
  it('prunes a preset belonging to a plugin no longer configured', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageWithPresets(['deck-creator'])
    ensurePluginPresets(dshHome, pkg, packageDir, 'presets')
    const dest = join(agentPresetsRoot(dshHome), 'deck-creator')
    expect(existsSync(dest)).toBe(true)

    reconcilePluginPresets(dshHome, new Set())

    expect(existsSync(dest)).toBe(false)
  })

  it('keeps a preset still in the keep set', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageWithPresets(['deck-creator'])
    ensurePluginPresets(dshHome, pkg, packageDir, 'presets')
    const dest = join(agentPresetsRoot(dshHome), 'deck-creator')

    reconcilePluginPresets(dshHome, new Set(['deck-creator']))

    expect(existsSync(dest)).toBe(true)
  })

  it('never removes a directory the app did not write, even outside the keep set', () => {
    const dshHome = freshHome()
    const dest = join(agentPresetsRoot(dshHome), 'hand-authored')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'preset.yml'), 'id: hand-authored\n')

    reconcilePluginPresets(dshHome, new Set())

    expect(existsSync(dest)).toBe(true)
  })
})

describe('non-fatal failure', () => {
  it('falls back rather than throwing when a copy fails', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageWithPresets(['deck-creator'])
    mkdirSync(agentPresetsRoot(dshHome), { recursive: true })
    chmodSync(agentPresetsRoot(dshHome), 0o444)
    try {
      expect(() => ensurePluginPresets(dshHome, pkg, packageDir, 'presets')).not.toThrow()
    } finally {
      chmodSync(agentPresetsRoot(dshHome), 0o755)
    }
  })
})
