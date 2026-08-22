import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConfigurationError } from './configuration-error'
import type { HarnessSource } from './harness-source'
import type { PluginEntry } from './plugin-entries'

/** Resolved desktop settings. `pnpmPath`/`npmPath` pin binaries when PATH cannot find them. */
export interface DesktopConfig {
  harness: HarnessSource
  notifyPort: number
  hotkey: string
  pnpmPath?: string
  npmPath?: string
  /**
   * Packages the desktop shell installs and inserts into the harness,
   * managed exactly like `harness`'s own managed source — pinned, cached,
   * update-checked. Optional so a `desktop.json` predating this field stays
   * valid; absent means no plugins configured, not "use the defaults".
   */
  plugins?: PluginEntry[]
}

export const DEFAULT_NOTIFY_PORT = 43117
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D'

/** Either the stored settings, or the first-run state where none exist yet. */
export type ConfigResult =
  | { configured: true; config: DesktopConfig }
  | { configured: false }

/**
 * Read the desktop config.
 *
 * A missing file is the first-run state, reported rather than guessed at:
 * the app has no way to know where a harness checkout lives on this machine,
 * so the user is asked instead (see the settings window).
 * @param filePath - absolute path to `desktop.json`.
 * @returns the stored settings, or the not-configured state.
 */
export function loadConfig(filePath: string): ConfigResult {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    // Only ENOENT means "nothing stored yet". Anything else — EACCES, or
    // EISDIR from a directory sitting where the file should be — means a real
    // config may exist and merely be unreadable, so it is rethrown loud rather
    // than being mistaken for a first run.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigurationError(`dsh-desktop: cannot read ${filePath}`, { cause: error })
    }
    return { configured: false }
  }
  return { configured: true, config: parseConfig(filePath, raw) }
}

/**
 * Parse and validate the desktop config contents.
 * @param filePath - absolute path to `desktop.json`, used only in error messages.
 * @param raw - the file's contents.
 * @returns the resolved settings.
 */
function parseConfig(filePath: string, raw: string): DesktopConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ConfigurationError(`dsh-desktop: ${filePath} is not valid JSON`, { cause })
  }

  const record = parsed as Partial<DesktopConfig>
  const harness = record.harness
  if (harness === undefined) {
    throw new ConfigurationError(`dsh-desktop: ${filePath} must set "harness" to a local or managed source`)
  }
  if (harness.kind === 'local') {
    if (typeof harness.repo !== 'string' || harness.repo === '') {
      throw new ConfigurationError(`dsh-desktop: ${filePath} local harness must set a non-empty "repo"`)
    }
  } else if (harness.kind === 'managed') {
    if (typeof harness.package !== 'string' || harness.package === '') {
      throw new ConfigurationError(`dsh-desktop: ${filePath} managed harness must set a non-empty "package"`)
    }
  } else {
    throw new ConfigurationError(`dsh-desktop: ${filePath} harness.kind must be "local" or "managed"`)
  }

  if (record.plugins !== undefined) {
    if (!Array.isArray(record.plugins) || record.plugins.some((entry) => typeof entry?.spec !== 'string')) {
      throw new ConfigurationError(`dsh-desktop: ${filePath} "plugins" must be a list of {spec, version?} entries`)
    }
  }

  return {
    harness,
    notifyPort: record.notifyPort ?? DEFAULT_NOTIFY_PORT,
    hotkey: record.hotkey ?? DEFAULT_HOTKEY,
    ...(record.pnpmPath === undefined ? {} : { pnpmPath: record.pnpmPath }),
    ...(record.npmPath === undefined ? {} : { npmPath: record.npmPath }),
    ...(record.plugins === undefined ? {} : { plugins: record.plugins }),
  }
}

/**
 * Persist the desktop config, creating its directory if needed.
 * @param filePath - absolute path to `desktop.json`.
 * @param config - settings to store.
 */
export function writeConfig(filePath: string, config: DesktopConfig): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(config, undefined, 2)}\n`)
}
