import type { ConfigResult, DesktopConfig } from './config'
import { parseSpec, type PluginEntry } from './plugin-entries'
import { formFor, validateSettings, type FieldErrors, type SettingsForm } from './settings-validate'

/** Everything the handlers need from the surrounding app, injected for testability. */
export interface SettingsDeps {
  readConfig(): ConfigResult
  writeConfig(config: DesktopConfig): void
  pickFolder(): Promise<string | undefined>
  /** Whether `port` can currently be bound on loopback. */
  probePort(port: number): Promise<boolean>
  /** Applies the change to the running app; returns non-blocking warnings to show. */
  apply(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<string[]>
  isQuitting(): boolean
  /**
   * Resolve the harness's own managed package's version or dist-tag to a
   * concrete version and install it if not already present, streaming `npm
   * install` output through `onLine`. Resolves to the concrete version,
   * which is what gets stored in config — never the tag the form submitted.
   */
  installManaged(
    pkg: string,
    version: string,
    npmPath: string | undefined,
    onLine: (line: string) => void,
  ): Promise<string>
  /**
   * The same resolve-then-install contract as `installManaged`, for a
   * plugin entry rather than the harness's own package. Kept distinct
   * because a plugin entry links no `bin`, so its install-complete check
   * cannot use the same marker `installManaged` checks for the harness.
   */
  installPlugin(
    pkg: string,
    version: string,
    npmPath: string | undefined,
    onLine: (line: string) => void,
  ): Promise<string>
  /**
   * The registry's current `latest` for a managed package, when it differs
   * from the installed version; `undefined` when it matches or the lookup
   * matches nothing. Update information is optional, so this may fail in
   * either of the two ways a function can: by rejecting, or by throwing
   * synchronously before any promise exists — resolving the `npm` binary can
   * fail outright under a Finder-minimal PATH. `read` treats both the same as
   * `undefined`.
   */
  checkManagedUpdate(pkg: string, installed: string, npmPath: string | undefined): Promise<string | undefined>
}

/** What `read` reports about one configured plugin entry, alongside the editable form. */
export interface PluginInfo {
  /** As typed by the user. */
  spec: string
  /** The parsed package name. */
  package: string
  /** True when the spec carried `@version` — never offered an update. */
  pinned: boolean
  /** The concrete, installed version, or undefined when a save has never installed it. */
  version?: string
}

/** What a save refused for overlapping another save reports on the `kind` field. */
export const SAVE_IN_PROGRESS = 'A save is already running; wait for it to finish and try again.'

/** Outcome of a save attempt. `warnings` carries non-blocking problems, such as a rejected hotkey. */
export type SaveResult = { ok: true; warnings: string[] } | { ok: false; errors: FieldErrors }

/** The operations the settings renderer can invoke. */
export interface SettingsHandlers {
  /**
   * @param onUpdateAvailable - called at most once, later and out of band,
   *   with the registry's `latest` version when the stored source is managed
   *   and a newer version exists. Never called on a local source, an
   *   unconfigured app, a failed or offline lookup, or an `npm` binary that
   *   cannot be resolved.
   * @param onPluginUpdateAvailable - the same out-of-band contract as
   *   `onUpdateAvailable`, per floating (non-pinned) plugin entry that has
   *   already been installed at least once. Never called for a pinned entry
   *   or one with no resolved version yet.
   */
  read(
    onUpdateAvailable?: (latest: string) => void,
    onPluginUpdateAvailable?: (pkg: string, latest: string) => void,
  ): { configured: boolean; form: SettingsForm; plugins: PluginInfo[] }
  pickFolder(): Promise<string | undefined>
  /**
   * Saves one form. Saves are serialized: a call made while another is still
   * running starts nothing and resolves with the running save's own outcome.
   * @param form - the submitted values.
   * @param onProgress - called with each line of `npm install` output while a
   *   managed source installs. Never called for a local source or an
   *   already-installed managed version.
   * @returns the save outcome.
   */
  save(form: SettingsForm, onProgress?: (line: string) => void): Promise<SaveResult>
  /**
   * Move one already-configured floating plugin entry to a specific,
   * explicitly accepted version, without pinning it: the entry's `spec`
   * stays exactly what it was, so it keeps being offered future updates the
   * same as before. Serialized with `save` through the same lock — this
   * still installs and writes config, so two of these (or one of these and a
   * `save`) running at once would race the same two hazards `save`'s own
   * lock exists to prevent.
   * @param pkg - the package name (not the raw spec) naming which entry to update.
   * @param version - the concrete version to install and store, from the
   *   update-available push this answers.
   * @param onProgress - called with each line of `npm install` output.
   * @returns the outcome, in the same shape as `save`.
   */
  acceptPluginUpdate(pkg: string, version: string, onProgress?: (line: string) => void): Promise<SaveResult>
}

/**
 * Build the settings handlers over injected dependencies.
 *
 * Validation runs before anything is written, so a rejected save never leaves
 * a partial config on disk, and `apply` runs only after a successful write.
 * @param deps - collaborators supplied by the main process.
 * @returns the handler set the IPC channels delegate to.
 */
export function createSettingsHandlers(deps: SettingsDeps): SettingsHandlers {
  /**
   * Whether a save is running, gating every entry point in the main process.
   *
   * A save is a minutes-long operation — `npm install`, a config write, then
   * `applySettings` — and the renderer's disabled Save button does not bound
   * it: the update hint's "use latest" is a second trigger, and closing and
   * reopening Settings mid-install produces a fresh window whose Save is
   * enabled. Two concurrent runs would mean two `npm install --prefix` into
   * one directory, two `writeConfig`, and two `applySettings`.
   *
   * The second save is refused rather than joined. Joining is right for
   * idempotent work like the tray's Restart, where every caller wants the one
   * same outcome; each save instead carries its own values, so handing the
   * second caller the first's result would report a local checkout as saved
   * while a managed install was applied — dropping the user's intent and
   * removing the very cue that would make them retry.
   */
  // Shared by `save` and `acceptPluginUpdate`: both install and write config, so either one running blocks the other the same way it blocks a second of itself.
  let saving = false

  /**
   * Install or verify every configured plugin entry, in order.
   *
   * A pinned entry's spec already names the exact version to install. A
   * floating entry installs its previously resolved version again (a cheap
   * cache hit — see `ensureInstalled`) or, the first time, `latest`; the
   * update it may be offered separately is never applied here on its own —
   * only an explicit spec change (typed by the user, or accepted through the
   * update hint) changes what gets installed.
   *
   * A single entry's install failure never fails the save: plugins are
   * best-effort the same way the notification hook bridge was before it
   * became a normal entry in this list. The previously resolved version (if
   * any) is kept rather than overwritten with an unresolved spec.
   * @param entries - the freshly validated entries (spec only, no version yet).
   * @param previous - the plugin entries stored before this save, for reuse and fallback.
   * @param npmPath - the configured `npm` binary override.
   * @param onProgress - receives `npm install` output lines.
   * @returns the resolved entries to store, and any per-entry warnings.
   */
  async function installPlugins(
    entries: PluginEntry[],
    previous: PluginEntry[],
    npmPath: string | undefined,
    onProgress: (line: string) => void,
  ): Promise<{ resolved: PluginEntry[]; warnings: string[] }> {
    const warnings: string[] = []
    const resolved: PluginEntry[] = []
    for (const entry of entries) {
      // Checked before every entry, not just once before the loop starts: a
      // quit can land between any two entries, and each `deps.installPlugin`
      // call spawns a detached `npm` that only `shutdown`'s own
      // `installs.stopAll()` — called once, before this loop could possibly
      // still be running — would ever reap. Without this check the loop
      // would keep spawning fresh, never-reaped installs behind that reap's
      // back for as long as entries remain. `installPlugin`'s own runner
      // additionally refuses to spawn at all once stopped (see
      // `install-process.ts`), so a quit landing between this check and the
      // spawn it guards is still caught there.
      if (deps.isQuitting()) break
      const { package: pkg, pinnedVersion } = parseSpec(entry.spec)
      const prior = previous.find((candidate) => parseSpec(candidate.spec).package === pkg)
      const versionToInstall = pinnedVersion ?? prior?.version ?? 'latest'
      try {
        const concrete = await deps.installPlugin(pkg, versionToInstall, npmPath, onProgress)
        resolved.push({ spec: entry.spec, version: concrete })
      } catch (error) {
        warnings.push(`${pkg} could not be installed: ${(error as Error).message}`)
        resolved.push({ spec: entry.spec, version: prior?.version })
      }
    }
    return { resolved, warnings }
  }

  /**
   * Validate, install, persist, and apply one settings form.
   * @param form - the submitted values.
   * @param onProgress - receives `npm install` output lines, for a managed source.
   * @returns the save outcome.
   */
  async function performSave(form: SettingsForm, onProgress?: (line: string) => void): Promise<SaveResult> {
    if (deps.isQuitting()) {
      return { ok: false, errors: { kind: 'The app is shutting down; settings were not saved.' } }
    }

    const validated = validateSettings(form)
    if (!validated.ok) return validated

    let config = validated.config
    if (config.harness.kind === 'managed') {
      const harness = config.harness
      let concreteVersion: string
      try {
        concreteVersion = await deps.installManaged(
          harness.package,
          harness.version,
          config.npmPath,
          onProgress ?? (() => {}),
        )
      } catch (error) {
        return { ok: false, errors: { version: (error as Error).message } }
      }
      config = { ...config, harness: { ...harness, version: concreteVersion } }
    }

    const stored = deps.readConfig()
    const previous = stored.configured ? stored.config : undefined

    const { resolved: resolvedPlugins, warnings: pluginWarnings } = await installPlugins(
      config.plugins ?? [],
      previous?.plugins ?? [],
      config.npmPath,
      onProgress ?? (() => {}),
    )
    config = { ...config, plugins: resolvedPlugins }

    // A save arriving while quitting is refused above; an install can run
    // for minutes, so quitting is re-checked here too — otherwise a quit
    // during a long install would still land a write and an apply behind
    // its back once the install finishes.
    if (deps.isQuitting()) {
      return { ok: false, errors: { kind: 'The app is shutting down; settings were not saved.' } }
    }

    if (previous?.notifyPort !== config.notifyPort) {
      if (!(await deps.probePort(config.notifyPort))) {
        return {
          ok: false,
          errors: { notifyPort: `Port ${String(config.notifyPort)} is already in use.` },
        }
      }
    }

    deps.writeConfig(config)
    const applyWarnings = await deps.apply(previous, config)
    return { ok: true, warnings: [...pluginWarnings, ...applyWarnings] }
  }

  /**
   * Install `version` for `pkg`'s already-configured floating entry, then
   * persist and apply just that one field change — `spec` is never touched,
   * which is what keeps the entry floating rather than silently pinning it
   * the way writing `pkg@version` into its spec would.
   * @param pkg - the package name identifying which entry to update.
   * @param version - the version to install and store.
   * @param onProgress - receives `npm install` output lines.
   * @returns the outcome.
   */
  async function performAcceptPluginUpdate(
    pkg: string,
    version: string,
    onProgress?: (line: string) => void,
  ): Promise<SaveResult> {
    if (deps.isQuitting()) {
      return { ok: false, errors: { kind: 'The app is shutting down; settings were not saved.' } }
    }

    const stored = deps.readConfig()
    if (!stored.configured) {
      return { ok: false, errors: { kind: `${pkg} is not configured yet.` } }
    }
    const previous = stored.config
    const entries = previous.plugins ?? []
    const index = entries.findIndex((entry) => parseSpec(entry.spec).package === pkg)
    if (index === -1) {
      return { ok: false, errors: { kind: `${pkg} is not a configured plugin.` } }
    }
    if (parseSpec(entries[index].spec).pinnedVersion !== undefined) {
      // Never reachable through the update hint (pinned entries are never
      // checked for updates), guarded anyway since this method is a distinct
      // entry point a future caller could reach some other way.
      return { ok: false, errors: { kind: `${pkg} is pinned; edit its line in Settings to change its version.` } }
    }

    let concrete: string
    try {
      concrete = await deps.installPlugin(pkg, version, previous.npmPath, onProgress ?? (() => {}))
    } catch (error) {
      return { ok: false, errors: { kind: `${pkg} could not be updated: ${(error as Error).message}` } }
    }

    // An install can run for minutes; a quit landing during it must not still
    // land a write and an apply behind the quit's back once it finishes.
    if (deps.isQuitting()) {
      return { ok: false, errors: { kind: 'The app is shutting down; settings were not saved.' } }
    }

    const updatedEntries = entries.map((entry, i) => (i === index ? { spec: entry.spec, version: concrete } : entry))
    const config: DesktopConfig = { ...previous, plugins: updatedEntries }
    deps.writeConfig(config)
    const warnings = await deps.apply(previous, config)
    return { ok: true, warnings }
  }

  return {
    read: (onUpdateAvailable, onPluginUpdateAvailable) => {
      const stored = deps.readConfig()
      if (onUpdateAvailable !== undefined && stored.configured && stored.config.harness.kind === 'managed') {
        const { package: pkg, version } = stored.config.harness
        try {
          deps
            .checkManagedUpdate(pkg, version, stored.config.npmPath)
            .then((latest) => {
              if (latest !== undefined) onUpdateAvailable(latest)
            })
            .catch(() => {
              // A failed or offline registry lookup is an optional nicety, not
              // an error the settings window should ever surface.
            })
        } catch {
          // The same nicety, failing one step earlier: `checkManagedUpdate`
          // resolves the `npm` binary before it has a promise to reject, and
          // that resolution throws when PATH is system-only and `npmPath` is
          // unset. Without this catch the throw escapes `read`, rejects the
          // IPC call, and leaves the user with a blank settings form — the one
          // screen that can fix the very config that caused the throw.
        }
      }

      const storedPlugins = stored.configured ? (stored.config.plugins ?? []) : []
      const plugins: PluginInfo[] = storedPlugins.map((entry) => {
        const { package: pkg, pinnedVersion } = parseSpec(entry.spec)
        return { spec: entry.spec, package: pkg, pinned: pinnedVersion !== undefined, version: entry.version }
      })

      // Update checks apply to floating entries only: a pinned entry's spec
      // already names the exact version the user wants, so it is never
      // offered anything else.
      if (onPluginUpdateAvailable !== undefined) {
        const npmPath = stored.configured ? stored.config.npmPath : undefined
        for (const plugin of plugins) {
          if (plugin.pinned || plugin.version === undefined) continue
          try {
            deps
              .checkManagedUpdate(plugin.package, plugin.version, npmPath)
              .then((latest) => {
                if (latest !== undefined) onPluginUpdateAvailable(plugin.package, latest)
              })
              .catch(() => {
                // Same optional nicety as the harness update check above.
              })
          } catch {
            // Same synchronous-throw nicety as the harness update check above.
          }
        }
      }

      return { configured: stored.configured, form: formFor(stored), plugins }
    },
    pickFolder: () => deps.pickFolder(),
    save: async (form, onProgress) => {
      if (saving) {
        return { ok: false, errors: { kind: SAVE_IN_PROGRESS } }
      }
      saving = true
      try {
        return await performSave(form, onProgress)
      } finally {
        saving = false
      }
    },
    acceptPluginUpdate: async (pkg, version, onProgress) => {
      if (saving) {
        return { ok: false, errors: { kind: SAVE_IN_PROGRESS } }
      }
      saving = true
      try {
        return await performAcceptPluginUpdate(pkg, version, onProgress)
      } finally {
        saving = false
      }
    },
  }
}
