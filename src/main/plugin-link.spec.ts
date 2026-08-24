import { describe, expect, it } from 'vitest'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedDir } from './harness-source'
import { ensurePluginLink, pluginLinkPath, profileNodeModulesDir, reconcilePluginLinks } from './plugin-link'

const PROFILE = 'web'

/** A fresh `$DSH_HOME`-shaped temp directory for one test. */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-desktop-link-'))
}

/** Write a fake managed install's own package directory and return it. */
function installedPackageDir(dshHome: string, pkg: string, version: string): string {
  const installDir = managedDir(dshHome, pkg, version)
  const pkgDir = join(installDir, 'node_modules', ...pkg.split('/'))
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
  writeFileSync(join(pkgDir, 'lib', 'index.js'), 'module.exports = {}\n')
  return pkgDir
}

describe('ensurePluginLink', () => {
  it('links a ready plugin into the profile node_modules by its bare package name', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageDir(dshHome, pkg, '0.2.1')

    const result = ensurePluginLink(dshHome, PROFILE, pkg, packageDir)

    expect(result).toEqual({ linked: true })
    const path = pluginLinkPath(dshHome, PROFILE, pkg)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path)).toBe(packageDir)
  })

  it('leaves an existing non-symlink install untouched and reports it as not linked', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageDir(dshHome, pkg, '0.2.1')

    // A real install, e.g. from `dsh plugin --profile web add`.
    const path = pluginLinkPath(dshHome, PROFILE, pkg)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: pkg, main: 'index.js' }))
    writeFileSync(join(path, 'sentinel.txt'), 'do not touch')

    const result = ensurePluginLink(dshHome, PROFILE, pkg, packageDir)

    expect(result.linked).toBe(false)
    if (!result.linked) expect(result.reason).toContain(path)
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    // Non-vacuity for "never clobbered": the sentinel file only survives if
    // `ensurePluginLink` genuinely skipped this path rather than unlinking
    // and replacing it.
    expect(lstatSync(join(path, 'sentinel.txt')).isFile()).toBe(true)
  })

  it('repoints an existing own link to a version change', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const oldDir = installedPackageDir(dshHome, pkg, '0.2.1')
    const newDir = installedPackageDir(dshHome, pkg, '0.3.0')

    expect(ensurePluginLink(dshHome, PROFILE, pkg, oldDir)).toEqual({ linked: true })
    expect(ensurePluginLink(dshHome, PROFILE, pkg, newDir)).toEqual({ linked: true })

    const path = pluginLinkPath(dshHome, PROFILE, pkg)
    expect(readlinkSync(path)).toBe(newDir)
  })

  it('falls back rather than dropping the plugin when linking fails', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageDir(dshHome, pkg, '0.2.1')

    // Make the profile's node_modules directory itself unwritable, so
    // `mkdirSync`/`symlinkSync` under it fails with EACCES.
    const nodeModules = profileNodeModulesDir(dshHome, PROFILE)
    mkdirSync(nodeModules, { recursive: true })
    chmodSync(nodeModules, 0o444)
    try {
      const result = ensurePluginLink(dshHome, PROFILE, pkg, packageDir)
      // Non-vacuity for "a link failure must not be fatal": this call must
      // not throw — the plugin is still resolvable by its `entryPath`, which
      // `index.ts`'s `resolveName` falls back to whenever this returns
      // `linked: false`, exactly like an unreadable directory.
      expect(result.linked).toBe(false)
    } finally {
      chmodSync(nodeModules, 0o755)
    }
  })
})

describe('reconcilePluginLinks', () => {
  it('removes the link for a plugin no longer configured', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageDir(dshHome, pkg, '0.2.1')
    ensurePluginLink(dshHome, PROFILE, pkg, packageDir)
    const path = pluginLinkPath(dshHome, PROFILE, pkg)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)

    reconcilePluginLinks(dshHome, PROFILE, new Set())

    expect(() => lstatSync(path)).toThrow()
  })

  it('cleans up a stale link whose target runtime no longer exists', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageDir(dshHome, pkg, '0.2.1')
    ensurePluginLink(dshHome, PROFILE, pkg, packageDir)
    const path = pluginLinkPath(dshHome, PROFILE, pkg)

    // The version directory this link points at is removed by other means
    // (an uninstall, a pruned runtime), leaving a dangling symlink — still
    // present in the profile's `node_modules`, but resolving nowhere.
    rmSync(join(dshHome, 'runtimes'), { recursive: true, force: true })
    expect(lstatSync(path).isSymbolicLink()).toBe(true)

    // Not kept: an unavailable/removed runtime means this boot never got as
    // far as re-linking it. `lstatSync` (not `statSync`) is what lets
    // `reconcilePluginLinks` still recognise the dangling symlink to remove
    // it, rather than reporting it as absent.
    reconcilePluginLinks(dshHome, PROFILE, new Set())

    expect(() => lstatSync(path)).toThrow()
  })

  it('keeps a linked package that is still in the keep set', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const packageDir = installedPackageDir(dshHome, pkg, '0.2.1')
    ensurePluginLink(dshHome, PROFILE, pkg, packageDir)
    const path = pluginLinkPath(dshHome, PROFILE, pkg)

    reconcilePluginLinks(dshHome, PROFILE, new Set([pkg]))

    expect(lstatSync(path).isSymbolicLink()).toBe(true)
  })

  it('never removes a real install directory, even when it is not in the keep set', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const path = pluginLinkPath(dshHome, PROFILE, pkg)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'sentinel.txt'), 'do not touch')

    reconcilePluginLinks(dshHome, PROFILE, new Set())

    expect(lstatSync(join(path, 'sentinel.txt')).isFile()).toBe(true)
  })

  it('never removes a foreign symlink that does not point into $DSH_HOME/runtimes', () => {
    const dshHome = freshHome()
    const pkg = '@onetest/dsh-deck'
    const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-desktop-elsewhere-'))
    const path = pluginLinkPath(dshHome, PROFILE, pkg)
    mkdirSync(join(dshHome, 'profiles', PROFILE, 'node_modules', '@onetest'), { recursive: true })
    symlinkSync(elsewhere, path)

    reconcilePluginLinks(dshHome, PROFILE, new Set())

    expect(lstatSync(path).isSymbolicLink()).toBe(true)
  })
})
