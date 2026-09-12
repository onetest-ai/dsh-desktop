import { DEFAULT_PLUGIN_SPECS } from './plugin-defaults'
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedDir } from './harness-source'
import {
  bundlePatchDeclaration,
  declaresClientHalf,
  defaultPlugins,
  entryKey,
  HOOKS_PACKAGE,
  parseSpec,
  parsePluginSource,
  pluginInstallMarker,
  pluginStatus,
  presetsDeclaration,
  resolvePluginEntry,
  validSpecShape,
} from './plugin-entries'
import type { InstallDeps } from './runtime-install'

const DSH_HOME = '/tmp/dsh-home'
const PKG = '@onetest/dsh-deck'

/** Builds an `InstallDeps` backed by an in-memory set of "existing" paths. */
function fakeDeps(existingPaths: Iterable<string> = []): InstallDeps {
  const set = new Set(existingPaths)
  return { run: vi.fn(), exists: (path) => set.has(path), mkdir: vi.fn(), rm: vi.fn(), rename: vi.fn() }
}

/**
 * Write a fake install under a fresh temp `npm install --prefix` directory,
 * with the given `package.json` fields for `pkg`.
 * @param pkg - the package name.
 * @param manifestExtra - the `main`/`exports` fields to publish, plus any others under test.
 * @returns the install directory (an `npm install --prefix` target).
 */
function installPackage(pkg: string, manifestExtra: Record<string, unknown>): string {
  const installDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-plugin-'))
  const pkgDir = join(installDir, 'node_modules', ...pkg.split('/'))
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, ...manifestExtra }))
  writeFileSync(join(pkgDir, 'lib', 'index.js'), 'module.exports = {}\n')
  return installDir
}

describe('defaultPlugins', () => {
  it('pre-seeds the notification hook bridge as the first entry', () => {
    expect(defaultPlugins()[0]).toEqual({ spec: HOOKS_PACKAGE })
  })

  it('ships whatever the default set declares, and nothing more', () => {
    // Empty while defaults cannot be installed at startup: a declared but
    // absent plugin reads as a failure the user did not cause.
    expect(defaultPlugins().map((entry) => entry.spec)).toEqual([HOOKS_PACKAGE, ...DEFAULT_PLUGIN_SPECS])
  })
})

describe('parseSpec', () => {
  it('parses an unscoped spec with a version', () => {
    expect(parseSpec('left-pad@1.2.3')).toEqual({ package: 'left-pad', pinnedVersion: '1.2.3' })
  })

  it('parses an unscoped spec without a version as floating', () => {
    expect(parseSpec('left-pad')).toEqual({ package: 'left-pad' })
  })

  it('parses a scoped spec with a version, not splitting on the scope\'s own @', () => {
    expect(parseSpec('@onetest/dsh-deck@0.2.1')).toEqual({ package: '@onetest/dsh-deck', pinnedVersion: '0.2.1' })
  })

  it('parses a scoped spec without a version as floating', () => {
    expect(parseSpec('@onetest/dsh-deck')).toEqual({ package: '@onetest/dsh-deck' })
  })
})

describe('parsePluginSource', () => {
  it('reads an npm spec as an npm source', () => {
    expect(parsePluginSource('@onetest/dsh-deck@0.2.1')).toEqual({ kind: 'npm', package: '@onetest/dsh-deck', pinnedVersion: '0.2.1' })
    expect(parsePluginSource('left-pad')).toEqual({ kind: 'npm', package: 'left-pad' })
  })

  it('reads a github spec with a ref', () => {
    expect(parsePluginSource('github:lincong1987/dsh-model-switch#main')).toEqual({
      kind: 'github', owner: 'lincong1987', repo: 'dsh-model-switch', ref: 'main',
    })
  })

  it('reads a github spec without a ref', () => {
    expect(parsePluginSource('github:TTTPOB/dsh-task-models')).toEqual({
      kind: 'github', owner: 'TTTPOB', repo: 'dsh-task-models',
    })
  })
})

describe('entryKey', () => {
  it('keys an npm entry by its package name, dropping the version', () => {
    expect(entryKey('@onetest/dsh-deck@0.2.1')).toBe('@onetest/dsh-deck')
    expect(entryKey('left-pad')).toBe('left-pad')
  })

  it('keys a github entry by owner/repo, dropping the ref', () => {
    expect(entryKey('github:TTTPOB/dsh-task-models#main')).toBe('github:TTTPOB/dsh-task-models')
    expect(entryKey('github:TTTPOB/dsh-task-models')).toBe('github:TTTPOB/dsh-task-models')
  })
})

describe('validSpecShape', () => {
  it.each([
    'github:owner/repo',
    'github:owner-1/repo.js#main',
    'github:a/b#v1.2.3',
    'github:a/b#feature/x',
  ])('accepts the github spec %s', (spec) => {
    expect(validSpecShape(spec)).toBe(true)
  })

  it.each([
    'github:/repo',
    'github:owner/',
    'github:owner',
    'github:../evil/repo',
    'github:owner/repo#..',
    'github:owner/re po',
    'github:owner/repo#a b',
  ])('rejects the malformed github spec %s', (spec) => {
    expect(validSpecShape(spec)).toBe(false)
  })
})

describe('resolvePluginEntry', () => {
  it('resolves the entry from exports["."].default over main', () => {
    const installDir = installPackage(PKG, {
      main: 'lib/wrong.js',
      exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
    })
    expect(resolvePluginEntry(installDir, PKG)).toBe(join(installDir, 'node_modules', '@onetest', 'dsh-deck', 'lib', 'index.js'))
  })

  it('falls back to main when exports names no root entry', () => {
    const installDir = installPackage(PKG, { main: 'lib/index.js', exports: { './invariant': './lib/invariant.js' } })
    expect(resolvePluginEntry(installDir, PKG)).toBe(join(installDir, 'node_modules', '@onetest', 'dsh-deck', 'lib', 'index.js'))
  })

  it('accepts a bare string exports["."]', () => {
    const installDir = installPackage(PKG, { main: 'lib/wrong.js', exports: { '.': './lib/index.js' } })
    expect(resolvePluginEntry(installDir, PKG)).toBe(join(installDir, 'node_modules', '@onetest', 'dsh-deck', 'lib', 'index.js'))
  })

  it('throws naming the package when neither exports nor main is declared', () => {
    const installDir = installPackage(PKG, {})
    expect(() => resolvePluginEntry(installDir, PKG)).toThrow(/exports\["\."\]|"main"/)
  })
})

describe('declaresClientHalf', () => {
  it('is true when the manifest declares dsh.client.platform "web"', () => {
    const installDir = installPackage(PKG, { main: 'lib/index.js', dsh: { client: { platform: 'web' } } })
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    expect(declaresClientHalf(pkgDir)).toBe(true)
  })

  it('is false, not throwing, for a package with no dsh.client declaration', () => {
    const installDir = installPackage(PKG, { main: 'lib/index.js' })
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    expect(declaresClientHalf(pkgDir)).toBe(false)
  })

  it('is false, not throwing, for an unreadable package.json', () => {
    expect(declaresClientHalf('/does/not/exist')).toBe(false)
  })
})

describe('presetsDeclaration', () => {
  it("returns the manifest's own dsh.presets value", () => {
    const installDir = installPackage(PKG, { main: 'lib/index.js', dsh: { presets: './presets' } })
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    expect(presetsDeclaration(pkgDir)).toBe('./presets')
  })

  it('is undefined, not throwing, for a package with no dsh.presets declaration', () => {
    const installDir = installPackage(PKG, { main: 'lib/index.js' })
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    expect(presetsDeclaration(pkgDir)).toBeUndefined()
  })

  it('is undefined, not throwing, for an unreadable package.json', () => {
    expect(presetsDeclaration('/does/not/exist')).toBeUndefined()
  })
})

describe('bundlePatchDeclaration', () => {
  it("returns the manifest's own dsh.bundle.patch value", () => {
    const installDir = installPackage(PKG, { main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    expect(bundlePatchDeclaration(pkgDir)).toBe('./cordis.patch.yml')
  })

  it('is undefined, not throwing, for a package with no dsh.bundle.patch declaration', () => {
    const installDir = installPackage(PKG, { main: 'lib/index.js' })
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    expect(bundlePatchDeclaration(pkgDir)).toBeUndefined()
  })

  it('is undefined, not throwing, for an unreadable package.json', () => {
    expect(bundlePatchDeclaration('/does/not/exist')).toBeUndefined()
  })
})

describe('pluginInstallMarker', () => {
  it("points at the installed package's own package.json, not a dsh binary", () => {
    expect(pluginInstallMarker('/tmp/install', PKG)).toBe(join('/tmp/install', 'node_modules', '@onetest', 'dsh-deck', 'package.json'))
  })
})

describe('pluginStatus', () => {
  it('is unavailable, naming that a save has never installed it, when no version is resolved yet', () => {
    const status = pluginStatus(fakeDeps(), DSH_HOME, { spec: PKG })
    expect(status.kind).toBe('unavailable')
    if (status.kind === 'unavailable') expect(status.reason).toMatch(/not installed yet/)
  })

  it('is unavailable for a github entry whose discovered package name is not yet stored', () => {
    // A github entry that resolved its SHA but has no `package` yet cannot be
    // located in `node_modules`; it reads as not installed, keyed by its repo.
    const status = pluginStatus(fakeDeps(), DSH_HOME, { spec: 'github:owner/repo#main', version: 'abc123' })
    expect(status.kind).toBe('unavailable')
    if (status.kind === 'unavailable') expect(status.package).toBe('github:owner/repo')
  })

  it('resolves a github entry under its repo-keyed cache using the discovered package name', () => {
    // The cache is keyed by `github:owner/repo` and the SHA, while the
    // node_modules subpath is the discovered npm name — the two diverge.
    const installDir = managedDir(DSH_HOME, 'github:owner/repo', 'abc123')
    const pkgDir = join(installDir, 'node_modules', 'dsh-model-switch')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'module.exports = {}\n')

    const deps = fakeDeps([join(pkgDir, 'package.json')])
    const status = pluginStatus(deps, DSH_HOME, { spec: 'github:owner/repo#main', version: 'abc123', package: 'dsh-model-switch' })

    expect(status).toEqual({
      kind: 'ready',
      package: 'dsh-model-switch',
      entryPath: join(pkgDir, 'lib', 'index.js'),
      probeDirectory: installDir,
      packageDir: pkgDir,
      configPath: undefined,
      config: undefined,
    })
  })

  it('is unavailable, naming the missing directory, when the resolved version is not on disk', () => {
    const status = pluginStatus(fakeDeps(), DSH_HOME, { spec: PKG, version: '0.2.1' })
    expect(status.kind).toBe('unavailable')
    if (status.kind === 'unavailable') expect(status.reason).toContain('0.2.1')
  })

  it('is ready with the resolved entry file when the resolved version is installed', () => {
    const installDir = managedDir(DSH_HOME, PKG, '0.2.1')
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    // `resolvePluginEntry` reads real fs, so the fixture is written into the
    // real (temp-free) `managedDir` path under a throwaway `DSH_HOME`.
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'module.exports = {}\n')

    const deps = fakeDeps([join(pkgDir, 'package.json')])
    const status = pluginStatus(deps, DSH_HOME, { spec: PKG, version: '0.2.1' })

    expect(status).toEqual({
      kind: 'ready',
      package: PKG,
      entryPath: join(pkgDir, 'lib', 'index.js'),
      probeDirectory: installDir,
      packageDir: pkgDir,
      configPath: undefined,
      config: undefined,
    })
  })

  it('carries the configPath through for the entry the caller privileges with one', () => {
    const installDir = managedDir(DSH_HOME, HOOKS_PACKAGE, '0.1.1-rc.2')
    const pkgDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-hooks-claude-code')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'module.exports = {}\n')

    const deps = fakeDeps([join(pkgDir, 'package.json')])
    const status = pluginStatus(deps, DSH_HOME, { spec: HOOKS_PACKAGE, version: '0.1.1-rc.2' }, '/tmp/hooks.json')

    expect(status.kind).toBe('ready')
    if (status.kind === 'ready') expect(status.configPath).toBe('/tmp/hooks.json')
  })

  it("carries the entry's own stored config through for a ready status", () => {
    const installDir = managedDir(DSH_HOME, PKG, '0.2.1')
    const pkgDir = join(installDir, 'node_modules', '@onetest', 'dsh-deck')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
    writeFileSync(join(pkgDir, 'lib', 'index.js'), 'module.exports = {}\n')

    const deps = fakeDeps([join(pkgDir, 'package.json')])
    const status = pluginStatus(deps, DSH_HOME, { spec: PKG, version: '0.2.1', config: { base: '/x' } })

    expect(status.kind).toBe('ready')
    if (status.kind === 'ready') expect(status.config).toEqual({ base: '/x' })
  })
})
