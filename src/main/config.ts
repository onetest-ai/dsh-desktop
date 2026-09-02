import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from './atomic-write'
import { ConfigurationError } from './configuration-error'
import type { HarnessSource } from './harness-source'
import { validSpecShape, type PluginEntry } from './plugin-entries'

/** Resolved desktop settings. `pnpmPath`/`npmPath` pin binaries when PATH cannot find them. */
export interface DesktopConfig {
  harness: HarnessSource
  notifyPort: number
  hotkey: string
  pnpmPath?: string
  npmPath?: string
  /**
   * Extra `PATH` entries for the harness child, prepended ahead of the
   * resolved login-shell PATH.
   *
   * An override for a machine where shell resolution fails — a shell this app
   * cannot run, or an rc file that establishes tools some other way. It is
   * not the mechanism: the resolved PATH is, and it self-heals across version
   * manager upgrades where a hardcoded entry does not.
   */
  extraPath?: string
  /**
   * The shell the built-in terminal runs, as an absolute path.
   *
   * Absent means the login shell `$SHELL` names, and a platform default when
   * it names none. Configurable for the reason VS Code makes it
   * configurable: `$SHELL` is what the machine logs you in with, which is not
   * always what you want a terminal inside an editor to run.
   */
  terminalShell?: string
  /**
   * Packages the desktop shell installs and inserts into the harness,
   * managed exactly like `harness`'s own managed source — pinned, cached,
   * update-checked. Optional so a `desktop.json` predating this field stays
   * valid; absent means no plugins configured, not "use the defaults".
   */
  plugins?: PluginEntry[]
  /**
   * Whether MCP servers are mounted at all.
   *
   * Only the master switch lives here; the servers themselves live in
   * `mcp.json` (see `mcp-config.ts`), in the format other MCP clients use, so
   * a block can be pasted between them unmodified. Absent means off.
   */
  mcpEnabled?: boolean
  /**
   * The concrete installed version of the MCP client package, resolved by a
   * save exactly like a plugin entry's `version`.
   *
   * App state, not server configuration, so it stays here rather than in
   * `mcp.json` — that file is the portable one, and a version this app
   * happens to have installed means nothing to another MCP client.
   */
  mcpClientVersion?: string
  /**
   * Each side column's last width and whether it was showing.
   *
   * Window state rather than settings: written by dragging a divider, not by
   * the Settings form, and never surfaced there. A stored width is only a
   * request — `layout` clamps it to what the current window can give, so a
   * config written on a wider display cannot strand the harness here.
   */
  pane?: {
    editor: { width: number; open: boolean }
    /**
     * The side column, which holds either the file tree or the git panel.
     *
     * `view` is absent from every file written before the git panel existed,
     * so it is read as `files` rather than refused — the column that has
     * always been the tree opens as the tree.
     */
    files: { width: number; open: boolean; view: 'files' | 'git' }
    /**
     * The terminal panel. Absent in a file written before it existed, which
     * opens it closed at its default size rather than refusing to load.
     */
    terminal?: { width: number; height: number; open: boolean }
  }
  /**
   * Whether this app offers the agent its view tools — open a file, open a
   * page, show a proposed change, read the selection.
   *
   * Absent means on: the tools are what make the pane something the agent can
   * use rather than a viewer the user drives alone.
   */
  viewTools?: boolean
  /** The loopback port those tools are served on. */
  viewToolsPort?: number
}

export const DEFAULT_NOTIFY_PORT = 43117

/**
 * The loopback port the view tools are served on.
 *
 * Fixed rather than OS-assigned so the overlay the harness child reads names
 * the same port across restarts; a taken port is reported and the tools
 * simply do not come up.
 */
export const DEFAULT_VIEW_TOOLS_PORT = 43118
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
    // The Settings form validates a freshly typed spec before it is ever
    // written (see `settings-validate.ts`'s `parsePluginsField`), but this
    // file can also be hand-edited directly — a spec shaped like a path
    // (e.g. `../../x`) would otherwise reach `packageDirIn`'s raw
    // `join(..., ...pkg.split('/'))` unchecked and land in the overlay's
    // import. Every entry is re-validated here so a spec that reaches
    // `pluginStatus` has always passed this check, regardless of which path
    // it arrived by.
    for (const entry of record.plugins) {
      if (!validSpecShape(entry.spec)) {
        throw new ConfigurationError(`dsh-desktop: ${filePath} plugin spec "${entry.spec}" is not a valid package name or package@version`)
      }
      // Same defense-in-depth as the spec check above: the Settings form
      // validates a freshly typed config before it is ever written (see
      // `settings-validate.ts`'s `parsePluginConfig`), but a hand-edited
      // `desktop.json` reaches `patchOverlay` through this same field, so an
      // array/string/null here — which `JSON.stringify` would happily emit as
      // a non-object overlay `config:` value — is rejected up front instead.
      if (entry.config !== undefined && (typeof entry.config !== 'object' || entry.config === null || Array.isArray(entry.config))) {
        throw new ConfigurationError(`dsh-desktop: ${filePath} plugin "${entry.spec}" config must be a JSON object`)
      }
    }
  }

  if (record.extraPath !== undefined && typeof record.extraPath !== 'string') {
    throw new ConfigurationError(`dsh-desktop: ${filePath} "extraPath" must be a string`)
  }
  if (record.terminalShell !== undefined && typeof record.terminalShell !== 'string') {
    throw new ConfigurationError(`dsh-desktop: ${filePath} "terminalShell" must be a string`)
  }

  // Unlike every check above, a malformed `pane` is dropped rather than
  // thrown: it is window state this app writes for itself, never something
  // the user is asked to get right, and refusing to start over a bad pane
  // width would take away the window that fixes it.
  const pane = paneState(record.pane)

  return {
    harness,
    notifyPort: record.notifyPort ?? DEFAULT_NOTIFY_PORT,
    hotkey: record.hotkey ?? DEFAULT_HOTKEY,
    ...(record.pnpmPath === undefined ? {} : { pnpmPath: record.pnpmPath }),
    ...(record.npmPath === undefined ? {} : { npmPath: record.npmPath }),
    ...(record.extraPath === undefined ? {} : { extraPath: record.extraPath }),
    ...(record.terminalShell === undefined ? {} : { terminalShell: record.terminalShell }),
    ...(record.plugins === undefined ? {} : { plugins: record.plugins }),
    ...(record.mcpEnabled === undefined ? {} : { mcpEnabled: record.mcpEnabled }),
    ...(record.mcpClientVersion === undefined ? {} : { mcpClientVersion: record.mcpClientVersion }),
    ...(pane === undefined ? {} : { pane }),
    ...(typeof record.viewTools === 'boolean' ? { viewTools: record.viewTools } : {}),
    ...(typeof record.viewToolsPort === 'number' ? { viewToolsPort: record.viewToolsPort } : {}),
  }
}

/**
 * Read the stored pane state, or undefined when there is nothing usable.
 * @param value - the `pane` member, from a file that may have been hand-edited.
 * @returns the state, or undefined to fall back to the default.
 */
function paneState(value: unknown): DesktopConfig['pane'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { editor, files } = value as Record<string, unknown>
  const { terminal } = value as Record<string, unknown>
  const both = [column(editor), column(files)]
  if (both[0] === undefined || both[1] === undefined) return undefined
  const panel = column(terminal)
  const height = (terminal as { height?: unknown } | null)?.height
  return {
    editor: both[0],
    files: { ...both[1], view: (files as { view?: unknown } | null)?.view === 'git' ? 'git' : 'files' },
    // The panel needs a height as well as a width, and one without is not a
    // panel this can restore — it opens at the default instead.
    ...(panel === undefined || typeof height !== 'number' || !Number.isFinite(height) || height <= 0
      ? {}
      : { terminal: { ...panel, height: Math.round(height) } }),
  }
}

/**
 * Read one column's stored state, or undefined when it is not usable.
 * @param value - one member of the `pane` block.
 * @returns the column's width and open flag, or undefined.
 */
function column(value: unknown): { width: number; open: boolean } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { width, open } = value as Record<string, unknown>
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return undefined
  return { width: Math.round(width), open: open === true }
}

/**
 * Persist the desktop config, creating its directory if needed.
 * @param filePath - absolute path to `desktop.json`.
 * @param config - settings to store.
 */
export function writeConfig(filePath: string, config: DesktopConfig): void {
  // Atomic: this file is rewritten whenever a column moves, and a reader that
  // caught it half-written would see a broken configuration.
  writeFileAtomic(filePath, `${JSON.stringify(config, undefined, 2)}\n`)
}
