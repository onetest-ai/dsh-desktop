import type { ConfigResult, DesktopConfig } from './config'
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
   * Resolve a managed package's version or dist-tag to a concrete version and
   * install it if not already present, streaming `npm install` output through
   * `onLine`. Resolves to the concrete version, which is what gets stored in
   * config — never the tag the form submitted.
   */
  installManaged(
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
   */
  read(onUpdateAvailable?: (latest: string) => void): { configured: boolean; form: SettingsForm }
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
  let saving = false

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

    // A save arriving while quitting is refused above; an install can run
    // for minutes, so quitting is re-checked here too — otherwise a quit
    // during a long install would still land a write and an apply behind
    // its back once the install finishes.
    if (deps.isQuitting()) {
      return { ok: false, errors: { kind: 'The app is shutting down; settings were not saved.' } }
    }

    const stored = deps.readConfig()
    const previous = stored.configured ? stored.config : undefined

    if (previous?.notifyPort !== config.notifyPort) {
      if (!(await deps.probePort(config.notifyPort))) {
        return {
          ok: false,
          errors: { notifyPort: `Port ${String(config.notifyPort)} is already in use.` },
        }
      }
    }

    deps.writeConfig(config)
    const warnings = await deps.apply(previous, config)
    return { ok: true, warnings }
  }

  return {
    read: (onUpdateAvailable) => {
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
      return { configured: stored.configured, form: formFor(stored) }
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
  }
}
