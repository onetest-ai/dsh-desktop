import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPackageLoadable, hooksConfig, patchOverlay, writeRuntimeFiles, type LoadabilityProbe } from './runtime-files'

/**
 * Build a fixture `node_modules` tree on disk so `checkPackageLoadable` can be
 * exercised against real filesystem resolution rather than a stubbed probe.
 *
 * `@fixture/main` always exists, declaring `dependencies` and
 * `peerDependencies` (with an optional `peerDependenciesMeta`) as given.
 * Each name in `presentPackages` also gets a real, resolvable package next to
 * it; a declared dependency or peer left out of that list is absent, exactly
 * like a broken or partial install.
 * @param manifestExtra - the `dependencies`/`peerDependencies`/`peerDependenciesMeta` fields for `@fixture/main`.
 * @param presentPackages - names (besides `@fixture/main` itself) to actually create.
 * @returns the directory to resolve `@fixture/main` from.
 */
function buildFixture(
  manifestExtra: {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  },
  presentPackages: string[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-fixture-'))
  const modules = join(root, 'node_modules', '@fixture')
  mkdirSync(modules, { recursive: true })

  const mainDir = join(modules, 'main')
  mkdirSync(join(mainDir, 'lib'), { recursive: true })
  writeFileSync(
    join(mainDir, 'package.json'),
    JSON.stringify({ name: '@fixture/main', main: 'lib/index.js', ...manifestExtra }),
  )
  writeFileSync(join(mainDir, 'lib', 'index.js'), 'module.exports = {}\n')

  for (const name of presentPackages) {
    const dir = join(modules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, main: 'index.js' }))
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  }

  return root
}

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

  // Real-filesystem fixtures, not a stubbed probe: this is the reproduced bug
  // (the hook bridge's `dsh-hook-protocol` dependency is a peer, not a plain
  // dependency), so the walk over `manifest.dependencies` alone must not be
  // the thing exercised here.

  it('reports the missing peer by name when a required peer dependency is absent', () => {
    const root = buildFixture({ peerDependencies: { '@fixture/peer': '*' } }, [])
    const reason = checkPackageLoadable('@fixture/main', root)
    expect(reason).toBeDefined()
    expect(reason).toContain('@fixture/peer')
  })

  it('is loadable when an optional peer dependency is absent', () => {
    const root = buildFixture(
      {
        peerDependencies: { '@fixture/peer': '*' },
        peerDependenciesMeta: { '@fixture/peer': { optional: true } },
      },
      [],
    )
    expect(checkPackageLoadable('@fixture/main', root)).toBeUndefined()
  })

  it('is loadable when the package and every declared dependency and required peer resolve', () => {
    const root = buildFixture(
      {
        dependencies: { '@fixture/dep': '*' },
        peerDependencies: { '@fixture/peer': '*' },
      },
      ['dep', 'peer'],
    )
    expect(checkPackageLoadable('@fixture/main', root)).toBeUndefined()
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
