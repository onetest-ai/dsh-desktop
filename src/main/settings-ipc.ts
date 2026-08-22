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
   * fails. A rejection is treated by the caller the same as `undefined` — see
   * `read` below — so this may also reject.
   */
  checkManagedUpdate(pkg: string, installed: string, npmPath: string | undefined): Promise<string | undefined>
}

/** Outcome of a save attempt. `warnings` carries non-blocking problems, such as a rejected hotkey. */
export type SaveResult = { ok: true; warnings: string[] } | { ok: false; errors: FieldErrors }

/** The operations the settings renderer can invoke. */
export interface SettingsHandlers {
  /**
   * @param onUpdateAvailable - called at most once, later and out of band,
   *   with the registry's `latest` version when the stored source is managed
   *   and a newer version exists. Never called on a local source, an
   *   unconfigured app, or a failed/offline lookup.
   */
  read(onUpdateAvailable?: (latest: string) => void): { configured: boolean; form: SettingsForm }
  pickFolder(): Promise<string | undefined>
  /**
   * @param onProgress - called with each line of `npm install` output while a
   *   managed source installs. Never called for a local source or an
   *   already-installed managed version.
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
  return {
    read: (onUpdateAvailable) => {
      const stored = deps.readConfig()
      if (onUpdateAvailable !== undefined && stored.configured && stored.config.harness.kind === 'managed') {
        const { package: pkg, version } = stored.config.harness
        deps
          .checkManagedUpdate(pkg, version, stored.config.npmPath)
          .then((latest) => {
            if (latest !== undefined) onUpdateAvailable(latest)
          })
          .catch(() => {
            // A failed or offline registry lookup is an optional nicety, not
            // an error the settings window should ever surface.
          })
      }
      return { configured: stored.configured, form: formFor(stored) }
    },
    pickFolder: () => deps.pickFolder(),
    async save(form: SettingsForm, onProgress?: (line: string) => void): Promise<SaveResult> {
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
    },
  }
}
