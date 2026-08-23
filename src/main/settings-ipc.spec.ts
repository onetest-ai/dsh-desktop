import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsHandlers, SAVE_IN_PROGRESS, type SettingsDeps } from './settings-ipc'
import type { SettingsForm } from './settings-validate'
import type { DesktopConfig } from './config'

const REPO = mkdtempSync(join(tmpdir(), 'dsh-repo-'))
const PKG = '@deepseek-ai/dsh'
const DECK = '@onetest/dsh-deck'

const HOOKS_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

/**
 * Build plugin rows from a compact "one spec per line" string, the shape
 * most of this file's cases only care about the spec for — a config text is
 * never exercised here (see `settings-validate.spec.ts` for that).
 * @param text - specs, one per line.
 * @returns rows with an empty config for every spec.
 */
function rows(text: string): SettingsForm['plugins'] {
  return text.split('\n').map((spec) => ({ spec, config: '' }))
}

function form(overrides: Partial<SettingsForm> = {}): SettingsForm {
  return {
    kind: 'local', repo: REPO, package: PKG, version: 'latest',
    workspace: '', notifyPort: '43117', hotkey: 'CommandOrControl+Shift+D',
    pnpmPath: '', npmPath: '', plugins: [], ...overrides,
  }
}

const STORED: DesktopConfig = {
  harness: { kind: 'local', repo: REPO },
  notifyPort: 43117,
  hotkey: 'CommandOrControl+Shift+D',
}

const MANAGED_STORED: DesktopConfig = {
  harness: { kind: 'managed', package: PKG, version: '0.1.1-rc.2', workspace: REPO },
  notifyPort: 43117,
  hotkey: 'CommandOrControl+Shift+D',
}

function deps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    readConfig: () => ({ configured: true, config: STORED }),
    writeConfig: vi.fn(),
    pickFolder: vi.fn(async () => '/picked'),
    probePort: vi.fn(async () => true),
    apply: vi.fn(async () => []),
    isQuitting: () => false,
    installManaged: vi.fn(async (_pkg, version) => version),
    installPlugin: vi.fn(async (_pkg, version) => version),
    checkManagedUpdate: vi.fn(async () => undefined),
    checkBinaries: vi.fn(async () => ({ pnpm: { ok: true, version: '9.0.0' }, npm: { ok: true, version: '10.0.0' } })),
    disabledPlugins: vi.fn(() => ({})),
    openConfigFile: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  }
}

describe('read', () => {
  it('returns the stored values as form fields, with an empty plugin list', () => {
    expect(createSettingsHandlers(deps()).read()).toEqual({
      configured: true,
      form: expect.objectContaining({ kind: 'local', repo: REPO, notifyPort: '43117' }),
      plugins: [],
    })
  })

  it('returns defaults on a first run', () => {
    const handlers = createSettingsHandlers(deps({ readConfig: () => ({ configured: false }) }))
    expect(handlers.read()).toEqual({
      configured: false,
      form: expect.objectContaining({ repo: '', notifyPort: '43117' }),
      plugins: [],
    })
  })

  it('reports an available update for a managed source, out of band', async () => {
    const checkManagedUpdate = vi.fn(async () => '0.2.0')
    const d = deps({ readConfig: () => ({ configured: true, config: MANAGED_STORED }), checkManagedUpdate })
    const onUpdateAvailable = vi.fn()

    createSettingsHandlers(d).read(onUpdateAvailable)
    await Promise.resolve()
    await Promise.resolve()

    expect(checkManagedUpdate).toHaveBeenCalledWith(PKG, '0.1.1-rc.2', undefined)
    expect(onUpdateAvailable).toHaveBeenCalledWith('0.2.0')
  })

  it('stays silent when the update lookup fails, rather than surfacing an error', async () => {
    // Non-vacuity: with the `.catch` in `read` removed, this test's rejected
    // `checkManagedUpdate` promise becomes an unhandled rejection and the test
    // fails instead of passing quietly. Restoring the catch fixes it.
    const checkManagedUpdate = vi.fn(async () => {
      throw new Error('registry unreachable')
    })
    const d = deps({ readConfig: () => ({ configured: true, config: MANAGED_STORED }), checkManagedUpdate })
    const onUpdateAvailable = vi.fn()

    createSettingsHandlers(d).read(onUpdateAvailable)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(onUpdateAvailable).not.toHaveBeenCalled()
  })

  it('never checks for an update on a local source', () => {
    const checkManagedUpdate = vi.fn(async () => '0.2.0')
    const d = deps({ checkManagedUpdate })
    createSettingsHandlers(d).read(vi.fn())
    expect(checkManagedUpdate).not.toHaveBeenCalled()
  })

  describe('plugins', () => {
    const withPlugins = (plugins: DesktopConfig['plugins']): DesktopConfig => ({ ...STORED, plugins })

    it('reports pinned and floating entries, each with its parsed package and resolved version', () => {
      const d = deps({
        readConfig: () => ({
          configured: true,
          config: withPlugins([
            { spec: `${DECK}@0.2.1`, version: '0.2.1' },
            { spec: HOOKS_PACKAGE, version: '0.1.1-rc.2' },
          ]),
        }),
      })

      const { plugins } = createSettingsHandlers(d).read()

      expect(plugins).toEqual([
        { spec: `${DECK}@0.2.1`, package: DECK, pinned: true, version: '0.2.1', config: '' },
        { spec: HOOKS_PACKAGE, package: HOOKS_PACKAGE, pinned: false, version: '0.1.1-rc.2', config: '' },
      ])
    })

    it('offers an update for a floating entry, out of band', async () => {
      const checkManagedUpdate = vi.fn(async () => '0.3.0')
      const d = deps({
        readConfig: () => ({ configured: true, config: withPlugins([{ spec: DECK, version: '0.2.1' }]) }),
        checkManagedUpdate,
      })
      const offered: { pkg: string; latest: string }[] = []

      createSettingsHandlers(d).read(undefined, (pkg, latest) => offered.push({ pkg, latest }))
      await Promise.resolve()
      await Promise.resolve()

      expect(checkManagedUpdate).toHaveBeenCalledWith(DECK, '0.2.1', undefined)
      expect(offered).toEqual([{ pkg: DECK, latest: '0.3.0' }])
    })

    it('never offers an update for a pinned entry', async () => {
      // Non-vacuity: with the `plugin.pinned` guard removed from `read`, this
      // test fails because the pinned entry's higher registry version is
      // reported anyway. Restoring the guard fixes it.
      const checkManagedUpdate = vi.fn(async () => '0.3.0')
      const d = deps({
        readConfig: () => ({ configured: true, config: withPlugins([{ spec: `${DECK}@0.2.1`, version: '0.2.1' }]) }),
        checkManagedUpdate,
      })
      const offered: { pkg: string; latest: string }[] = []

      createSettingsHandlers(d).read(undefined, (pkg, latest) => offered.push({ pkg, latest }))
      await Promise.resolve()
      await Promise.resolve()

      expect(checkManagedUpdate).not.toHaveBeenCalled()
      expect(offered).toEqual([])
    })

    it('never checks an entry that has not been installed yet', () => {
      const checkManagedUpdate = vi.fn(async () => '0.3.0')
      const d = deps({
        readConfig: () => ({ configured: true, config: withPlugins([{ spec: DECK }]) }),
        checkManagedUpdate,
      })

      createSettingsHandlers(d).read(undefined, vi.fn())

      expect(checkManagedUpdate).not.toHaveBeenCalled()
    })

    it("carries the boot's own disabled reason for a matching package, and nothing for the rest", () => {
      // `disabledPlugins` reflects main-process state a boot last recorded,
      // independent of this `read` call — the very thing that lets a
      // Settings window opened long after boot still show an accurate
      // reason, rather than only one that happened to be open at boot time.
      const d = deps({
        readConfig: () => ({
          configured: true,
          config: withPlugins([{ spec: `${DECK}@0.2.1`, version: '0.2.1' }, { spec: HOOKS_PACKAGE, version: '0.1.1-rc.2' }]),
        }),
        disabledPlugins: () => ({ [DECK]: 'base must be a non-empty string starting with "/", received undefined (at base)' }),
      })

      const { plugins } = createSettingsHandlers(d).read()

      expect(plugins.find((plugin) => plugin.package === DECK)?.disabledReason).toBe(
        'base must be a non-empty string starting with "/", received undefined (at base)',
      )
      expect(plugins.find((plugin) => plugin.package === HOOKS_PACKAGE)?.disabledReason).toBeUndefined()
    })
  })
})

describe('pickFolder', () => {
  it('returns the chosen path', async () => {
    await expect(createSettingsHandlers(deps()).pickFolder()).resolves.toBe('/picked')
  })

  it('returns undefined when cancelled', async () => {
    const handlers = createSettingsHandlers(deps({ pickFolder: async () => undefined }))
    await expect(handlers.pickFolder()).resolves.toBeUndefined()
  })
})

describe('save', () => {
  it('writes and applies a valid form', async () => {
    const d = deps()
    const result = await createSettingsHandlers(d).save(form())
    expect(result).toEqual({ ok: true, warnings: [] })
    expect(d.writeConfig).toHaveBeenCalledWith({
      harness: { kind: 'local', repo: REPO },
      notifyPort: 43117,
      hotkey: 'CommandOrControl+Shift+D',
      plugins: [],
    })
    expect(d.apply).toHaveBeenCalledWith(STORED, expect.objectContaining({ notifyPort: 43117 }))
  })

  it('returns field errors and writes nothing when invalid', async () => {
    const d = deps()
    const result = await createSettingsHandlers(d).save(form({ repo: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toBeDefined()
    expect(d.writeConfig).not.toHaveBeenCalled()
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('rejects a port that is already bound, naming it', async () => {
    const d = deps({ probePort: async () => false })
    const result = await createSettingsHandlers(d).save(form({ notifyPort: '5000' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.notifyPort).toContain('5000')
    expect(d.writeConfig).not.toHaveBeenCalled()
  })

  it('does not probe a port that is unchanged', async () => {
    const d = deps()
    await createSettingsHandlers(d).save(form())
    expect(d.probePort).not.toHaveBeenCalled()
  })

  it('probes only when the port actually changes', async () => {
    const d = deps()
    await createSettingsHandlers(d).save(form({ notifyPort: '5000' }))
    expect(d.probePort).toHaveBeenCalledWith(5000)
  })

  it('refuses to save while the app is quitting', async () => {
    const d = deps({ isQuitting: () => true })
    const result = await createSettingsHandlers(d).save(form())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.kind).toMatch(/quitting|shutting down/i)
    expect(d.writeConfig).not.toHaveBeenCalled()
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('passes undefined as previous on a first run', async () => {
    const d = deps({ readConfig: () => ({ configured: false }) })
    await createSettingsHandlers(d).save(form())
    expect(d.apply).toHaveBeenCalledWith(undefined, expect.anything())
  })

  it('does not apply when writing fails', async () => {
    const d = deps({ writeConfig: vi.fn(() => { throw new Error('disk full') }) })
    await expect(createSettingsHandlers(d).save(form())).rejects.toThrow(/disk full/)
    expect(d.apply).not.toHaveBeenCalled()
  })

  describe('a managed source', () => {
    it('resolves and installs, storing the concrete version rather than the submitted tag', async () => {
      const installManaged = vi.fn(async () => '0.1.1-rc.2')
      const d = deps({ installManaged })
      const result = await createSettingsHandlers(d).save(form({ kind: 'managed', version: 'latest', workspace: REPO }))

      expect(result).toEqual({ ok: true, warnings: [] })
      expect(installManaged).toHaveBeenCalledWith(PKG, 'latest', undefined, expect.any(Function))
      expect(d.writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ harness: { kind: 'managed', package: PKG, version: '0.1.1-rc.2', workspace: REPO } }),
      )
    })

    it('streams install progress through onProgress', async () => {
      const installManaged = vi.fn(async (_pkg: string, _version: string, _npmPath: string | undefined, onLine: (line: string) => void) => {
        onLine('added 455 packages')
        return '0.1.1-rc.2'
      })
      const d = deps({ installManaged })
      const progress: string[] = []

      await createSettingsHandlers(d).save(form({ kind: 'managed' }), (line) => progress.push(line))

      expect(progress).toEqual(['added 455 packages'])
    })

    it('rejects the save when install fails, without writing', async () => {
      const installManaged = vi.fn(async () => {
        throw new Error('npm install failed: network timeout')
      })
      const d = deps({ installManaged })
      const result = await createSettingsHandlers(d).save(form({ kind: 'managed' }))

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.version).toContain('network timeout')
      expect(d.writeConfig).not.toHaveBeenCalled()
      expect(d.apply).not.toHaveBeenCalled()
    })

    it('refuses to write when quitting arrives during a long install, even though the save started before it', async () => {
      let quitting = false
      const installManaged = vi.fn(async () => {
        // The install "completes" only after a quit lands mid-flight.
        quitting = true
        return '0.1.1-rc.2'
      })
      const d = deps({ installManaged, isQuitting: () => quitting })
      const result = await createSettingsHandlers(d).save(form({ kind: 'managed' }))

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.kind).toMatch(/quitting|shutting down/i)
      expect(d.writeConfig).not.toHaveBeenCalled()
      expect(d.apply).not.toHaveBeenCalled()
    })
  })

  describe('plugins', () => {
    it('installs a pinned entry at exactly its spec\'s version, reusing the shared installer', async () => {
      const installPlugin = vi.fn(async (_pkg: string, version: string) => version)
      const d = deps({ installPlugin })

      const result = await createSettingsHandlers(d).save(form({ plugins: rows(`${DECK}@0.2.1`) }))

      expect(result).toEqual({ ok: true, warnings: [] })
      expect(installPlugin).toHaveBeenCalledWith(DECK, '0.2.1', undefined, expect.any(Function))
      expect(d.writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ plugins: [{ spec: `${DECK}@0.2.1`, version: '0.2.1' }] }),
      )
    })

    it('persists a row config alongside the resolved entry', async () => {
      const installPlugin = vi.fn(async (_pkg: string, version: string) => version)
      const d = deps({ installPlugin })

      await createSettingsHandlers(d).save(form({ plugins: [{ spec: `${DECK}@0.2.1`, config: '{"base": "/x"}' }] }))

      expect(d.writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ plugins: [{ spec: `${DECK}@0.2.1`, version: '0.2.1', config: { base: '/x' } }] }),
      )
    })

    it('rejects malformed row config before installing anything', async () => {
      const installPlugin = vi.fn(async (_pkg: string, version: string) => version)
      const d = deps({ installPlugin })

      const result = await createSettingsHandlers(d).save(form({ plugins: [{ spec: DECK, config: '{not json' }] }))

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.plugins).toMatch(/not valid JSON/i)
      expect(installPlugin).not.toHaveBeenCalled()
      expect(d.writeConfig).not.toHaveBeenCalled()
    })

    it('resolves a floating entry with no prior version to latest', async () => {
      const installPlugin = vi.fn(async () => '0.2.1')
      const d = deps({ installPlugin })

      await createSettingsHandlers(d).save(form({ plugins: rows(DECK) }))

      expect(installPlugin).toHaveBeenCalledWith(DECK, 'latest', undefined, expect.any(Function))
    })

    it('reinstalls a floating entry at its previously resolved version, not latest again', async () => {
      const installPlugin = vi.fn(async (_pkg: string, version: string) => version)
      const d = deps({
        installPlugin,
        readConfig: () => ({ configured: true, config: { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }] } }),
      })

      await createSettingsHandlers(d).save(form({ plugins: rows(DECK) }))

      expect(installPlugin).toHaveBeenCalledWith(DECK, '0.2.1', undefined, expect.any(Function))
    })

    it('adds and removes entries, round-tripping through config', async () => {
      const installPlugin = vi.fn(async (_pkg: string, version: string) => (version === 'latest' ? '1.0.0' : version))
      const d = deps({
        installPlugin,
        readConfig: () => ({
          configured: true,
          config: { ...STORED, plugins: [{ spec: HOOKS_PACKAGE, version: '0.1.1-rc.2' }, { spec: DECK, version: '0.2.1' }] },
        }),
      })

      // The saved form keeps the bridge, drops the deck, and adds a third entry.
      await createSettingsHandlers(d).save(form({ plugins: rows(`${HOOKS_PACKAGE}\n@onetest/other`) }))

      expect(d.writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          plugins: [{ spec: HOOKS_PACKAGE, version: '0.1.1-rc.2' }, { spec: '@onetest/other', version: '1.0.0' }],
        }),
      )
    })

    it('keeps the previously resolved version and reports a warning when an install fails', async () => {
      const installPlugin = vi.fn(async () => {
        throw new Error('registry unreachable')
      })
      const d = deps({
        installPlugin,
        readConfig: () => ({ configured: true, config: { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }] } }),
      })

      const result = await createSettingsHandlers(d).save(form({ plugins: rows(DECK) }))

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.warnings[0]).toMatch(/dsh-deck.*registry unreachable/)
      expect(d.writeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ plugins: [{ spec: DECK, version: '0.2.1' }] }),
      )
    })

    it('never fails the whole save because one plugin failed to install', async () => {
      const d = deps({
        installPlugin: vi.fn(async () => {
          throw new Error('offline')
        }),
      })

      const result = await createSettingsHandlers(d).save(form({ plugins: rows(DECK) }))

      expect(result.ok).toBe(true)
      expect(d.apply).toHaveBeenCalled()
    })

    it('stops installing further entries once quitting lands mid-loop, leaving them unattempted', async () => {
      // Five entries queued; quitting flips true right after the first
      // install call resolves. Without the per-entry `isQuitting()` check
      // the loop would keep calling `installPlugin` for every remaining
      // entry — each one a detached `npm` that `shutdown`'s single, already-
      // finished `installs.stopAll()` would never reap again.
      let quitting = false
      const installPlugin = vi.fn(async (pkg: string) => {
        quitting = true
        return pkg === '@onetest/a' ? '1.0.0' : 'unreachable'
      })
      const d = deps({ installPlugin, isQuitting: () => quitting })

      const result = await createSettingsHandlers(d).save(
        form({ plugins: rows('@onetest/a\n@onetest/b\n@onetest/c\n@onetest/d\n@onetest/e') }),
      )

      expect(installPlugin).toHaveBeenCalledTimes(1)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.kind).toMatch(/quitting|shutting down/i)
      expect(d.writeConfig).not.toHaveBeenCalled()
      expect(d.apply).not.toHaveBeenCalled()
    })
  })
})

describe('acceptPluginUpdate', () => {
  const CONFIG_WITH_FLOATING_DECK: DesktopConfig = { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }] }

  it('installs the accepted version and stores it, keeping the entry\'s spec bare — still floating', async () => {
    // This is the behavior "Use it" relies on: writing `pkg@version` into the
    // spec is what pins an entry, so accepting an update must move `version`
    // alone and leave `spec` exactly as it was, or the plugin would silently
    // stop being offered any future update.
    const installPlugin = vi.fn(async () => '0.3.0')
    const d = deps({ installPlugin, readConfig: () => ({ configured: true, config: CONFIG_WITH_FLOATING_DECK }) })

    const result = await createSettingsHandlers(d).acceptPluginUpdate(DECK, '0.3.0')

    expect(result).toEqual({ ok: true, warnings: [], version: '0.3.0' })
    expect(installPlugin).toHaveBeenCalledWith(DECK, '0.3.0', undefined, expect.any(Function))
    expect(d.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: [{ spec: DECK, version: '0.3.0' }] }),
    )
  })

  it("returns the resolved version, not the requested one, when they differ", async () => {
    // `installPlugin` resolves its `version` argument through the same
    // `resolveVersion` a fresh `npm view` call always is — a real mismatch
    // is unlikely for an already-concrete version, but the caller must never
    // assume it: this is what lets `settings.js` show the row what actually
    // got written instead of echoing back what it asked for.
    const installPlugin = vi.fn(async () => '0.3.1')
    const d = deps({ installPlugin, readConfig: () => ({ configured: true, config: CONFIG_WITH_FLOATING_DECK }) })

    const result = await createSettingsHandlers(d).acceptPluginUpdate(DECK, '0.3.0')

    expect(result).toEqual({ ok: true, warnings: [], version: '0.3.1' })
    expect(d.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: [{ spec: DECK, version: '0.3.1' }] }),
    )
  })

  it('never rewrites spec to pkg@version, even though the concrete version resolved matches', async () => {
    const installPlugin = vi.fn(async () => '0.3.0')
    const d = deps({ installPlugin, readConfig: () => ({ configured: true, config: CONFIG_WITH_FLOATING_DECK }) })

    await createSettingsHandlers(d).acceptPluginUpdate(DECK, '0.3.0')

    const written = d.writeConfig.mock.calls[0][0] as DesktopConfig
    const deck = written.plugins?.find((entry) => entry.spec.startsWith(DECK))
    expect(deck?.spec).toBe(DECK)
    expect(deck?.spec).not.toContain('@0.3.0')
  })

  it('refuses a pinned entry rather than reinstalling it', async () => {
    const installPlugin = vi.fn(async () => '0.3.0')
    const d = deps({
      installPlugin,
      readConfig: () => ({ configured: true, config: { ...STORED, plugins: [{ spec: `${DECK}@0.2.1`, version: '0.2.1' }] } }),
    })

    const result = await createSettingsHandlers(d).acceptPluginUpdate(DECK, '0.3.0')

    expect(result.ok).toBe(false)
    expect(installPlugin).not.toHaveBeenCalled()
    expect(d.writeConfig).not.toHaveBeenCalled()
  })

  it('refuses an unknown package', async () => {
    const d = deps({ readConfig: () => ({ configured: true, config: STORED }) })

    const result = await createSettingsHandlers(d).acceptPluginUpdate(DECK, '0.3.0')

    expect(result.ok).toBe(false)
    expect(d.writeConfig).not.toHaveBeenCalled()
  })

  it('refuses while quitting, before installing anything', async () => {
    const installPlugin = vi.fn(async () => '0.3.0')
    const d = deps({
      installPlugin,
      isQuitting: () => true,
      readConfig: () => ({ configured: true, config: CONFIG_WITH_FLOATING_DECK }),
    })

    const result = await createSettingsHandlers(d).acceptPluginUpdate(DECK, '0.3.0')

    expect(result.ok).toBe(false)
    expect(installPlugin).not.toHaveBeenCalled()
  })

  it('is serialized with save through the same lock', async () => {
    let release: (version: string) => void = () => {}
    const installPlugin = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    const d = deps({ installPlugin, readConfig: () => ({ configured: true, config: CONFIG_WITH_FLOATING_DECK }) })
    const handlers = createSettingsHandlers(d)

    const first = handlers.acceptPluginUpdate(DECK, '0.3.0')
    const second = await handlers.save(form())
    release('0.3.0')
    await first

    expect(second).toEqual({ ok: false, errors: { kind: SAVE_IN_PROGRESS } })
  })
})

describe('a failing update lookup', () => {
  it('still returns the stored form when checkManagedUpdate throws synchronously', () => {
    // What `resolveBinary` does when PATH is system-only and `npmPath` is
    // unset: it throws before any promise exists, so a `.catch()` on the
    // result never attaches. Escaping here would reject `settings:read` and
    // leave the user with a blank form on the one screen that fixes it.
    const checkManagedUpdate = vi.fn(() => {
      throw new Error('dsh-desktop: npm is not on PATH')
    })
    const handlers = createSettingsHandlers(
      deps({ readConfig: () => ({ configured: true, config: MANAGED_STORED }), checkManagedUpdate }),
    )

    const result = handlers.read(() => {})

    expect(checkManagedUpdate).toHaveBeenCalled()
    expect(result.configured).toBe(true)
    expect(result.form).toEqual(
      expect.objectContaining({ kind: 'managed', package: PKG, version: '0.1.1-rc.2' }),
    )
  })

  it('never reports an update when the lookup throws synchronously', () => {
    const handlers = createSettingsHandlers(
      deps({
        readConfig: () => ({ configured: true, config: MANAGED_STORED }),
        checkManagedUpdate: vi.fn(() => {
          throw new Error('dsh-desktop: npm is not on PATH')
        }),
      }),
    )
    const offered: string[] = []

    handlers.read((latest) => offered.push(latest))

    expect(offered).toEqual([])
  })
})

describe('concurrent saves', () => {
  it('refuses a second save instead of reporting the first one\'s outcome as its own', async () => {
    // The reachable paths: the update hint's "use latest" button, which the
    // renderer never disables, and a settings window reopened mid-install,
    // whose Save starts enabled. Each save carries different values, so the
    // running save's outcome is not an answer to this one — being told
    // "Settings saved." for a form that was never applied drops the user's
    // intent and removes the cue that would make them retry.
    let releaseInstall: (version: string) => void = () => {}
    let hungOnce = false
    const installManaged = vi.fn((_pkg: string, version: string) => {
      if (!hungOnce) {
        hungOnce = true
        return new Promise<string>((resolve) => {
          releaseInstall = resolve
        })
      }
      return Promise.resolve(version)
    })
    const writeConfig = vi.fn()
    const apply = vi.fn(async () => [])
    const handlers = createSettingsHandlers(deps({ installManaged, writeConfig, apply }))

    const first = handlers.save(form({ kind: 'managed', version: '0.1.1-rc.2', workspace: REPO }))
    const second = await handlers.save(form({ kind: 'local', repo: REPO }))
    releaseInstall('0.1.1-rc.2')
    await first

    expect(second).toEqual({ ok: false, errors: { kind: SAVE_IN_PROGRESS } })
    expect(installManaged).toHaveBeenCalledTimes(1)
    expect(writeConfig).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(writeConfig).toHaveBeenCalledWith(expect.objectContaining({ harness: expect.objectContaining({ kind: 'managed' }) }))
  })

  it('starts a fresh save once the previous one has finished', async () => {
    const writeConfig = vi.fn()
    const handlers = createSettingsHandlers(deps({ writeConfig }))

    await handlers.save(form())
    await handlers.save(form())

    expect(writeConfig).toHaveBeenCalledTimes(2)
  })

  it('never applies the values of a save it refused', async () => {
    const writeConfig = vi.fn()
    const apply = vi.fn(async () => [])
    const handlers = createSettingsHandlers(deps({ writeConfig, apply, probePort: vi.fn(async () => true) }))

    const first = handlers.save(form({ hotkey: 'CommandOrControl+Shift+D' }))
    const second = await handlers.save(form({ hotkey: 'CommandOrControl+Shift+K' }))
    await first

    expect(second).toEqual({ ok: false, errors: { kind: SAVE_IN_PROGRESS } })
    expect(writeConfig).toHaveBeenCalledTimes(1)
    expect(writeConfig).toHaveBeenCalledWith(expect.objectContaining({ hotkey: 'CommandOrControl+Shift+D' }))
  })
})

describe('validatePlugin', () => {
  it('accepts a well-shaped, non-duplicate spec, mirroring what save would accept', () => {
    const handlers = createSettingsHandlers(deps())
    expect(handlers.validatePlugin(`${DECK}@0.2.1`, [HOOKS_PACKAGE])).toEqual({
      ok: true,
      plugin: { spec: `${DECK}@0.2.1`, package: DECK, pinned: true },
    })
  })

  it('rejects a malformed spec without touching disk', () => {
    const writeConfig = vi.fn()
    const handlers = createSettingsHandlers(deps({ writeConfig }))
    const result = handlers.validatePlugin('../../etc', [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/package name/i)
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('rejects a package already in the given list', () => {
    const handlers = createSettingsHandlers(deps())
    const result = handlers.validatePlugin(DECK, [DECK])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe(`${DECK} is already in the list.`)
  })
})

describe('validatePluginConfig', () => {
  it('accepts blank text as no config', () => {
    const handlers = createSettingsHandlers(deps())
    expect(handlers.validatePluginConfig('')).toEqual({ ok: true, config: undefined })
  })

  it('accepts a JSON object', () => {
    const handlers = createSettingsHandlers(deps())
    expect(handlers.validatePluginConfig('{"base": "/x"}')).toEqual({ ok: true, config: { base: '/x' } })
  })

  it('rejects malformed JSON without touching disk', () => {
    const writeConfig = vi.fn()
    const handlers = createSettingsHandlers(deps({ writeConfig }))
    const result = handlers.validatePluginConfig('{not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/not valid JSON/i)
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('rejects a JSON value that is not an object', () => {
    const handlers = createSettingsHandlers(deps())
    const result = handlers.validatePluginConfig('[1, 2, 3]')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/JSON object/i)
  })
})

describe('checkBinaries', () => {
  it('forwards the two form values verbatim and returns the answer, writing nothing', async () => {
    const writeConfig = vi.fn()
    const checkBinaries = vi.fn(async (pnpmPath: string, npmPath: string) => ({
      pnpm: { ok: true as const, version: `pnpm-for-${pnpmPath}` },
      npm: { ok: true as const, version: `npm-for-${npmPath}` },
    }))
    const handlers = createSettingsHandlers(deps({ writeConfig, checkBinaries }))

    const result = await handlers.checkBinaries('/opt/pnpm', '')

    expect(checkBinaries).toHaveBeenCalledWith('/opt/pnpm', '')
    expect(result).toEqual({
      pnpm: { ok: true, version: 'pnpm-for-/opt/pnpm' },
      npm: { ok: true, version: 'npm-for-' },
    })
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('runs freely alongside a save already in flight, unlike a second save', async () => {
    let releaseInstall: (() => void) | undefined
    const installManaged = vi.fn(
      async (_pkg: string, version: string) =>
        new Promise<string>((resolve) => {
          releaseInstall = () => resolve(version)
        }),
    )
    const checkBinaries = vi.fn(async () => ({ pnpm: { ok: true as const, version: '9.0.0' }, npm: { ok: true as const, version: '10.0.0' } }))
    const handlers = createSettingsHandlers(deps({ installManaged, checkBinaries }))

    const saving = handlers.save(form({ kind: 'managed', package: PKG, version: 'latest', workspace: REPO }))
    const result = await handlers.checkBinaries('', '')
    expect(result).toEqual({ pnpm: { ok: true, version: '9.0.0' }, npm: { ok: true, version: '10.0.0' } })

    releaseInstall?.()
    await saving
  })
})

describe('openConfigFile', () => {
  it('delegates to deps and returns its outcome, writing nothing', async () => {
    const writeConfig = vi.fn()
    const openConfigFile = vi.fn(async () => ({ ok: true }) as const)
    const handlers = createSettingsHandlers(deps({ writeConfig, openConfigFile }))

    const result = await handlers.openConfigFile()

    expect(openConfigFile).toHaveBeenCalledWith()
    expect(result).toEqual({ ok: true })
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('surfaces a failure from deps rather than swallowing it', async () => {
    const openConfigFile = vi.fn(async () => ({ ok: false, error: 'No application can open this file.' }) as const)
    const handlers = createSettingsHandlers(deps({ openConfigFile }))

    const result = await handlers.openConfigFile()

    expect(result).toEqual({ ok: false, error: 'No application can open this file.' })
  })

  it('runs freely alongside a save already in flight, unlike a second save', async () => {
    let releaseInstall: (() => void) | undefined
    const installManaged = vi.fn(
      async (_pkg: string, version: string) =>
        new Promise<string>((resolve) => {
          releaseInstall = () => resolve(version)
        }),
    )
    const openConfigFile = vi.fn(async () => ({ ok: true }) as const)
    const handlers = createSettingsHandlers(deps({ installManaged, openConfigFile }))

    const saving = handlers.save(form({ kind: 'managed', package: PKG, version: 'latest', workspace: REPO }))
    const result = await handlers.openConfigFile()
    expect(result).toEqual({ ok: true })

    releaseInstall?.()
    await saving
  })
})
