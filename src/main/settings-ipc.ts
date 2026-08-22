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
}

/** Outcome of a save attempt. `warnings` carries non-blocking problems, such as a rejected hotkey. */
export type SaveResult = { ok: true; warnings: string[] } | { ok: false; errors: FieldErrors }

/** The three operations the settings renderer can invoke. */
export interface SettingsHandlers {
  read(): { configured: boolean; form: SettingsForm }
  pickFolder(): Promise<string | undefined>
  save(form: SettingsForm): Promise<SaveResult>
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
    read: () => {
      const stored = deps.readConfig()
      return { configured: stored.configured, form: formFor(stored) }
    },
    pickFolder: () => deps.pickFolder(),
    async save(form: SettingsForm): Promise<SaveResult> {
      if (deps.isQuitting()) {
        return { ok: false, errors: { kind: 'The app is shutting down; settings were not saved.' } }
      }

      const validated = validateSettings(form)
      if (!validated.ok) return validated

      const stored = deps.readConfig()
      const previous = stored.configured ? stored.config : undefined

      if (previous?.notifyPort !== validated.config.notifyPort) {
        if (!(await deps.probePort(validated.config.notifyPort))) {
          return {
            ok: false,
            errors: { notifyPort: `Port ${String(validated.config.notifyPort)} is already in use.` },
          }
        }
      }

      deps.writeConfig(validated.config)
      const warnings = await deps.apply(previous, validated.config)
      return { ok: true, warnings }
    },
  }
}
