import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attributeBootFailure, checkPackageLoadable, hooksConfig, patchOverlay, writeRuntimeFiles, type LoadabilityProbe } from './runtime-files'
import type { PluginStatus } from './plugin-entries'

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

/**
 * Add a dependency package to a fixture tree that is installed and reachable
 * but exposes no root export — only a subpath, the way real packages such as
 * `@modelcontextprotocol/sdk` do. `require.resolve('@fixture/<name>')` throws
 * for a package built this way even though it is correctly installed.
 * @param root - the fixture root returned by `buildFixture`.
 * @param name - the dependency's name, without the `@fixture/` scope.
 */
function addSubpathOnlyDependency(root: string, name: string): void {
  const dir = join(root, 'node_modules', '@fixture', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@fixture/${name}`, exports: { './sub': './sub.js' } }),
  )
  writeFileSync(join(dir, 'sub.js'), 'module.exports = {}\n')
}

/** Always reports the candidate as loadable, regardless of `fromDirectory`. */
const alwaysLoadable: LoadabilityProbe = () => undefined

/** Always reports the candidate as unloadable, with a fixed reason. */
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
  it('mounts a plugin at the given name, single-quote-escaped', () => {
    const { overlay } = patchOverlay([{ package: '@deepseek-ai/dsh-hooks-claude-code', entryPath: "/tmp/o'brien/lib/index.js", name: "/tmp/o'brien/lib/index.js", configPath: "/tmp/o'brien/hooks.json" }], [])
    expect(overlay).toContain("configPath: '/tmp/o''brien/hooks.json'")
    expect(overlay).toContain("name: '/tmp/o''brien/lib/index.js'")
    expect(overlay).not.toContain("name: '@deepseek-ai/dsh-hooks-claude-code'")
    expect(overlay).toContain('port: 0')
  })

  it("mounts a linked entry by its bare package name, distinct from its own entryPath", () => {
    // `name` and `entryPath` diverge exactly when `plugin-link.ts` has
    // linked the entry into the profile's `node_modules`: the overlay uses
    // the bare name a user recognises, while `entryPath` is kept alongside
    // it (in `RuntimeFiles.ready`) purely for `attributeBootFailure`.
    const { overlay } = patchOverlay(
      [{ package: '@onetest/dsh-deck', entryPath: '/tmp/deck/lib/index.js', name: '@onetest/dsh-deck' }],
      [],
    )
    expect(overlay).toContain("name: '@onetest/dsh-deck'")
    expect(overlay).not.toContain("name: '/tmp/deck/lib/index.js'")
  })

  it('mounts a plugin with no configPath under an empty config object, never a configPath', () => {
    // cordis's own config resolution rejects an insert with no `config` node
    // at all ("expected a config object"); an empty object satisfies it
    // without giving a generic entry anything to configure.
    const { overlay } = patchOverlay([{ package: '@onetest/dsh-deck', entryPath: '/tmp/deck/lib/index.js', name: '/tmp/deck/lib/index.js' }], [])
    expect(overlay).toContain("name: '/tmp/deck/lib/index.js'")
    expect(overlay).toContain('config: {}')
    expect(overlay).not.toContain('configPath')
  })

  it('mounts every ready entry, each under its own id', () => {
    const { overlay } = patchOverlay(
      [
        { package: '@deepseek-ai/dsh-hooks-claude-code', entryPath: '/tmp/hooks/lib/index.js', name: '/tmp/hooks/lib/index.js', configPath: '/tmp/hooks.json' },
        { package: '@onetest/dsh-deck', entryPath: '/tmp/deck/lib/index.js', name: '/tmp/deck/lib/index.js' },
      ],
      [],
    )
    expect(overlay).toContain('id: deepseek-ai-dsh-hooks-claude-code')
    expect(overlay).toContain('id: onetest-dsh-deck')
    expect(overlay).toContain("name: '/tmp/hooks/lib/index.js'")
    expect(overlay).toContain("name: '/tmp/deck/lib/index.js'")
  })

  it('omits an unavailable entry and records the reason as a comment', () => {
    const { overlay } = patchOverlay([], [{ package: '@onetest/dsh-deck', reason: "cannot find package 'x'" }])
    expect(overlay).not.toContain('insert')
    expect(overlay).toContain("@onetest/dsh-deck was omitted: cannot find package 'x'")
    expect(overlay).toContain('port: 0')
  })

  it('mounts a ready entry while separately omitting a broken one', () => {
    const { overlay } = patchOverlay(
      [{ package: '@onetest/dsh-deck', entryPath: '/tmp/deck/lib/index.js', name: '/tmp/deck/lib/index.js' }],
      [{ package: '@deepseek-ai/dsh-hooks-claude-code', reason: 'not installed yet' }],
    )
    expect(overlay).toContain("name: '/tmp/deck/lib/index.js'")
    expect(overlay).toContain('@deepseek-ai/dsh-hooks-claude-code was omitted: not installed yet')
  })

  it("emits an entry's own stored config as a flow-style YAML mapping", () => {
    const { overlay } = patchOverlay(
      [{ package: '@onetest/dsh-deck', entryPath: '/tmp/deck/lib/index.js', name: '/tmp/deck/lib/index.js', config: { base: '/x', nested: { n: 1 } } }],
      [],
    )
    expect(overlay).toContain('config: {"base":"/x","nested":{"n":1}}')
    expect(overlay).not.toContain('config: {}')
  })

  it('keeps the empty-object default for an entry with no stored config', () => {
    const { overlay } = patchOverlay([{ package: '@onetest/dsh-deck', entryPath: '/tmp/deck/lib/index.js', name: '/tmp/deck/lib/index.js', config: undefined }], [])
    expect(overlay).toContain('config: {}')
  })

  it("mounts a package's own declared patch rows, its own id and name, instead of a synthesized row", () => {
    const { overlay } = patchOverlay(
      [
        {
          package: '@onetest/dsh-deck',
          entryPath: '/tmp/deck/lib/index.js',
          name: '@onetest/dsh-deck',
          declaredPatch: [{ id: 'deck', name: '@onetest/dsh-deck', config: { base: '/deck' } }],
        },
      ],
      [],
    )
    expect(overlay).toContain('id: deck')
    expect(overlay).not.toContain('id: onetest-dsh-deck')
    expect(overlay).toContain('base: /deck')
  })

  it("replaces a declared row's own config with the user's stored config, never merging", () => {
    const { overlay } = patchOverlay(
      [
        {
          package: '@onetest/dsh-deck',
          entryPath: '/tmp/deck/lib/index.js',
          name: '@onetest/dsh-deck',
          config: { base: '/typed' },
          declaredPatch: [{ id: 'deck', name: '@onetest/dsh-deck', config: { base: '/deck', extra: true } }],
        },
      ],
      [],
    )
    expect(overlay).toContain('base: /typed')
    expect(overlay).not.toContain('base: /deck')
    expect(overlay).not.toContain('extra')
  })

  it('keeps every other declared field (e.g. an extra companion row) untouched', () => {
    const { overlay } = patchOverlay(
      [
        {
          package: '@onetest/dsh-deck',
          entryPath: '/tmp/deck/lib/index.js',
          name: '@onetest/dsh-deck',
          declaredPatch: [
            { id: 'deck', name: '@onetest/dsh-deck' },
            { id: 'deck-companion', name: '@onetest/dsh-deck-companion' },
          ],
        },
      ],
      [],
    )
    expect(overlay).toContain('id: deck-companion')
    expect(overlay).toContain("name: '@onetest/dsh-deck-companion'")
  })

  it('falls back to a synthesized row when a declared row id collides with an already-used id', () => {
    const { overlay } = patchOverlay(
      [
        {
          package: '@onetest/dsh-webserver-lookalike',
          entryPath: '/tmp/lookalike/lib/index.js',
          name: '@onetest/dsh-webserver-lookalike',
          declaredPatch: [{ id: 'webserver', name: '@onetest/dsh-webserver-lookalike' }],
        },
      ],
      [],
    )
    // The one, reserved `webserver` row is the pinned host binding; a
    // declared row claiming that id must never shadow it.
    expect(overlay.match(/id: webserver/g)).toHaveLength(1)
    expect(overlay).toContain('id: onetest-dsh-webserver-lookalike')
  })

  it('falls back to a synthesized row when a package with no configPath still carries an empty declared patch', () => {
    // Defensive: `loadDeclaredPatchRows` never returns an empty array (see
    // its own tests), but `patchOverlay` must not crash if a caller ever did.
    const { overlay } = patchOverlay(
      [{ package: '@onetest/dsh-deck', entryPath: '/tmp/deck/lib/index.js', name: '@onetest/dsh-deck', declaredPatch: [] }],
      [],
    )
    expect(overlay).toContain('id: onetest-dsh-deck')
  })

  it('ignores a declared patch when the privileged configPath override is set', () => {
    const { overlay } = patchOverlay(
      [
        {
          package: '@deepseek-ai/dsh-hooks-claude-code',
          entryPath: '/tmp/bridge/lib/index.js',
          name: '@deepseek-ai/dsh-hooks-claude-code',
          configPath: '/tmp/hooks.json',
          declaredPatch: [{ id: 'bridge', name: '@deepseek-ai/dsh-hooks-claude-code' }],
        },
      ],
      [],
    )
    expect(overlay).toContain('id: deepseek-ai-dsh-hooks-claude-code')
    expect(overlay).not.toContain('id: bridge')
    expect(overlay).toContain("configPath: '/tmp/hooks.json'")
  })

  it('prefers the privileged configPath over a stored config when both are set', () => {
    const { overlay } = patchOverlay(
      [
        {
          package: '@deepseek-ai/dsh-hooks-claude-code',
          entryPath: '/tmp/hooks/lib/index.js',
          name: '/tmp/hooks/lib/index.js',
          configPath: '/tmp/hooks.json',
          config: { ignored: true },
        },
      ],
      [],
    )
    expect(overlay).toContain("configPath: '/tmp/hooks.json'")
    expect(overlay).not.toContain('ignored')
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

  it('reports a genuinely absent dependency, not just an absent peer', () => {
    const root = buildFixture({ dependencies: { '@fixture/dep': '*' } }, [])
    const reason = checkPackageLoadable('@fixture/main', root)
    expect(reason).toBeDefined()
    expect(reason).toContain('@fixture/dep')
  })

  // The regression this fix targets: @modelcontextprotocol/sdk is installed
  // and every plugin subpath import of it works, but it has no root export,
  // so a bare `require.resolve` on the dependency name alone throws and used
  // to falsely disable the plugin declaring it.
  it('treats a subpath-only dependency — installed, but with no root export — as present', () => {
    const root = buildFixture({ dependencies: { '@fixture/subpath-only': '*' } }, [])
    addSubpathOnlyDependency(root, 'subpath-only')
    expect(checkPackageLoadable('@fixture/main', root)).toBeUndefined()
  })

  it('never throws when a dependency manifest is malformed JSON', () => {
    const root = buildFixture({ dependencies: { '@fixture/dep': '*' } }, ['dep'])
    const depManifest = join(root, 'node_modules', '@fixture', 'dep', 'package.json')
    writeFileSync(depManifest, '{ not valid json')
    expect(() => checkPackageLoadable('@fixture/main', root)).not.toThrow()
  })

  it("never throws when the plugin's own manifest is malformed JSON", () => {
    const root = buildFixture({}, [])
    const mainManifest = join(root, 'node_modules', '@fixture', 'main', 'package.json')
    writeFileSync(mainManifest, '{ not valid json')
    expect(() => checkPackageLoadable('@fixture/main', root)).not.toThrow()
  })
})

/** A plugin candidate ready to probe from `/irrelevant`, with the given entry file. */
function ready(pkg = '@onetest/dsh-deck', entryPath = '/irrelevant/lib/index.js'): PluginStatus {
  return { kind: 'ready', package: pkg, entryPath, probeDirectory: '/irrelevant' }
}

/** A plugin already known to be unavailable, bypassing `probe` entirely. */
function unavailable(pkg: string, reason: string): PluginStatus {
  return { kind: 'unavailable', package: pkg, reason }
}

describe('writeRuntimeFiles', () => {
  it('includes the insert, pointed at the resolved entry file, when the plugin is loadable', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(directory, 44001, [ready('@onetest/dsh-deck', '/irrelevant/lib/index.js')], alwaysLoadable)

    expect(files.omitted).toEqual([])
    expect(files.patchPath).toBe(join(directory, 'desktop.patch.yml'))
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).toContain("name: '/irrelevant/lib/index.js'")
    expect(overlay).toContain('port: 0')
    expect(readFileSync(files.hooksPath, 'utf8')).toContain('127.0.0.1:44001')
  })

  it("carries a ready entry's own stored config through to the overlay", () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const status: PluginStatus = {
      kind: 'ready',
      package: '@onetest/dsh-deck',
      entryPath: '/irrelevant/lib/index.js',
      probeDirectory: '/irrelevant',
      config: { base: '/x' },
    }
    const files = writeRuntimeFiles(directory, 44001, [status], alwaysLoadable)

    expect(files.omitted).toEqual([])
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).toContain('config: {"base":"/x"}')
  })

  it('omits the insert and reports a reason when the plugin is not loadable', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(directory, 44001, [ready()], alwaysUnloadable)

    expect(files.omitted).toEqual([{ package: '@onetest/dsh-deck', reason: 'package not found' }])
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).not.toContain('insert')
    expect(overlay).toContain('was omitted: package not found')
    // The webserver pin is present either way.
    expect(overlay).toContain('port: 0')
  })

  it('omits the insert without probing when the plugin is already known to be unavailable, and still boots', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const probe = vi.fn(alwaysLoadable)
    const files = writeRuntimeFiles(directory, 44001, [unavailable('@onetest/dsh-deck', 'not installed yet')], probe)

    expect(probe).not.toHaveBeenCalled()
    expect(files.omitted).toEqual([{ package: '@onetest/dsh-deck', reason: 'not installed yet' }])
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).not.toContain('insert')
    expect(overlay).toContain('was omitted: not installed yet')
    // The webserver pin — what lets the harness boot — is written either way.
    expect(overlay).toContain('port: 0')
  })

  it('mounts one plugin while omitting another broken one, and still boots', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(
      directory,
      44001,
      [ready('@onetest/dsh-deck', '/irrelevant/deck/index.js'), unavailable('@deepseek-ai/dsh-hooks-claude-code', 'not installed yet')],
      alwaysLoadable,
    )

    expect(files.omitted).toEqual([{ package: '@deepseek-ai/dsh-hooks-claude-code', reason: 'not installed yet' }])
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).toContain("name: '/irrelevant/deck/index.js'")
    expect(overlay).toContain('port: 0')
  })

  it('rewrites the port when the configuration changes', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    writeRuntimeFiles(directory, 44001, [ready()], alwaysLoadable)
    const files = writeRuntimeFiles(directory, 44002, [ready()], alwaysLoadable)
    expect(readFileSync(files.hooksPath, 'utf8')).toContain('127.0.0.1:44002')
  })

  it('reports every mounted row, package paired with its overlay id and name, for `attributeBootFailure` to consult', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(directory, 44001, [ready('@onetest/dsh-deck', '/irrelevant/lib/index.js')], alwaysLoadable)

    expect(files.ready).toEqual([{ package: '@onetest/dsh-deck', id: 'onetest-dsh-deck', name: '/irrelevant/lib/index.js' }])
  })

  it("threads a ready entry's own declared patch rows through resolveDeclaredPatch into the overlay", () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(
      directory,
      44001,
      [ready('@onetest/dsh-deck', '/irrelevant/lib/index.js')],
      alwaysLoadable,
      (status) => status.package,
      () => [{ id: 'deck', name: '@onetest/dsh-deck', config: { base: '/deck' } }],
    )
    expect(files.omitted).toEqual([])
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).toContain('id: deck')
    expect(overlay).toContain('base: /deck')
  })

  it('keeps the synthesized row when resolveDeclaredPatch is not supplied, unchanged from before this feature', () => {
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-desktop-')), 'runtime')
    const files = writeRuntimeFiles(directory, 44001, [ready('@onetest/dsh-deck', '/irrelevant/lib/index.js')], alwaysLoadable)
    const overlay = readFileSync(files.patchPath, 'utf8')
    expect(overlay).toContain('id: onetest-dsh-deck')
  })
})

describe('attributeBootFailure', () => {
  const deck = { package: '@onetest/dsh-deck', id: 'onetest-dsh-deck', name: '/dsh-home/runtimes/x/@onetest/dsh-deck/lib/index.js' }
  const bridge = { package: '@deepseek-ai/dsh-hooks-claude-code', id: 'deepseek-ai-dsh-hooks-claude-code', name: '/dsh-home/runtimes/x/@deepseek-ai/dsh-hooks-claude-code/lib/index.js' }

  it("attributes the user's real needs-configuration failure to the one plugin it names, the other left with no reason", () => {
    // Verbatim wording from the reported regression: two configured
    // plugins, both linked by bare package name (see
    // `docs/notes/plugin-link-by-name.md`), only the mcp client named.
    const mcpClient = { package: '@deepseek-ai/dsh-mcp-client', id: 'deepseek-ai-dsh-mcp-client', name: '@deepseek-ai/dsh-mcp-client' }
    const healthyDeck = { package: '@onetest/dsh-deck', id: 'onetest-dsh-deck', name: '@onetest/dsh-deck' }
    const message =
      'failed to apply loader entry deepseek-ai-dsh-mcp-client (@deepseek-ai/dsh-mcp-client): invalid config: - expected { transport?: "stdio", serverName: string, command: string, args?: string[], env?: { [key: string]: string }, cwd?: string, toolCallTimeoutMs?: number, failOnStartupError?: boolean } | { transport?: "streamable-http", … } but got {}'
    expect(attributeBootFailure(message, [mcpClient, healthyDeck])).toBe(mcpClient.package)
  })

  it('attributes a failure to the one entry whose resolved path (not a bare package name) appears in the message, for an entry linking fell back to', () => {
    const message = `failed to apply loader entry onetest-dsh-deck (${deck.name}): invalid config: - base must be a non-empty string starting with "/", received undefined (at base)`
    expect(attributeBootFailure(message, [deck, bridge])).toBe(deck.package)
  })

  it("attributes to a package's own declared bundle-patch row by the id and name it actually declared, not a derived id", () => {
    // `@onetest/dsh-deck`'s own `cordis.patch.yml` mounts it as `id: deck`
    // (`docs/notes/declared-bundle-patch.md`) — neither the package name nor
    // `insertId`'s derived `onetest-dsh-deck`. The row-to-package mapping
    // this asserts comes from `patchOverlay`'s own generation, not a
    // re-derivation from the message.
    const declared = { package: '@onetest/dsh-deck', id: 'deck', name: '@onetest/dsh-deck' }
    const message = 'failed to apply loader entry deck (@onetest/dsh-deck): invalid config: - base must be a non-empty string starting with "/", received undefined (at base)'
    expect(attributeBootFailure(message, [declared, bridge])).toBe(declared.package)
  })

  it('is unattributable when the message names none of the ready rows', () => {
    expect(attributeBootFailure('the harness crashed on an unrelated assertion', [deck, bridge])).toBeUndefined()
  })

  it('is unattributable when the message genuinely names more than one ready row', () => {
    // Deliberately ambiguous: naming which of two candidates actually broke
    // would risk dropping a healthy plugin while leaving the real cause
    // running, so neither is picked.
    const message = `both (${deck.name}) and (${bridge.name}) appear in this message`
    expect(attributeBootFailure(message, [deck, bridge])).toBeUndefined()
  })

  it('falls back to the id only when it singles out exactly one row, never on a collision between two distinct packages sharing one sanitized id', () => {
    // `@a-b/c` and `@a/b-c` both sanitize to `a-b-c` — the collision a
    // previous version of this function avoided entirely by matching paths
    // instead; the id fallback here is used only once no row's own `name`
    // matched, and only when exactly one row carries the id.
    const a = { package: '@a-b/c', id: 'a-b-c', name: '@a-b/c' }
    const b = { package: '@a/b-c', id: 'a-b-c', name: '@a/b-c' }
    expect(attributeBootFailure('failed to apply loader entry a-b-c (unrecognized): some other error', [a, b])).toBeUndefined()
  })
})
