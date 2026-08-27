import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSpec, type PluginEntry } from './plugin-entries'

/**
 * The per-project MCP bridge, shipped by default.
 *
 * Pinned rather than floating. The package is two weeks old, publishes no
 * public repository, and spawns processes from project-supplied
 * configuration — so an update must be a deliberate act, not something that
 * arrives on the next install. Raising this version is a review, not a bump.
 *
 * It exists in the default set because the official client mounts one
 * connection per profile row, shared by every session: its `cwd` therefore
 * has a single value, and a server like Playwright writes its artifacts into
 * whichever directory the app happened to launch from. This bridge reads
 * `<session cwd>/.dsh/mcp.json` on `agent/created` and spawns per agent, so
 * each session's server runs in that session's own directory.
 */
export const PROJECT_MCP_BRIDGE = 'dsh-project-mcp-bridge@0.2.1'

/**
 * Plugins every install gets unless the user removes them.
 *
 * Safe to declare because startup repairs what the config declares: before
 * that phase existed, a default arrived declared-but-absent and the Plugins
 * tab reported it as a failure the user did nothing to cause.
 *
 * Kept as specs rather than resolved entries: the install path resolves and
 * pins a concrete version on first save, exactly as it does for a plugin the
 * user typed.
 */
/**
 * The harness-side controls for this app's own side pane.
 *
 * Its browser half puts a button at the sidebar foot that shows and hides the
 * pane. The pane can also be toggled from the View menu, so an install that
 * removes this plugin loses the button and nothing else.
 *
 * Pinned like every default: it ships from the same repository as this app
 * and is expected to move with it, which is exactly why an update should be
 * a deliberate raise rather than whatever `latest` happens to be.
 */
export const DESKTOP_PANE = '@onetest/dsh-desktop-pane@0.1.0'

export const DEFAULT_PLUGIN_SPECS: readonly string[] = [PROJECT_MCP_BRIDGE, DESKTOP_PANE]

/**
 * The defaults generation this build ships.
 *
 * Recorded in `desktop.json` once applied, so a default the user deliberately
 * removed is never silently reinstated. Adding a plugin to the default set
 * means raising this number.
 */
export const DEFAULTS_GENERATION = 2

/**
 * Add any default plugin this install has not seen yet.
 *
 * Runs once per generation. A user who removes a default keeps it removed:
 * the generation marker records that the offer was made, not that the plugin
 * is present.
 *
 * Never throws — an unreadable or unwritable config leaves the install
 * exactly as it was, and the app starts normally without the default.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns whether the config was changed.
 */
export function ensureDefaultPlugins(dshHome: string): boolean {
  const file = join(dshHome, 'desktop.json')
  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    // No config yet is a first run: `defaultPlugins()` seeds the form
    // instead, so there is nothing to migrate.
    return false
  }
  if (typeof config.pluginDefaultsGeneration === 'number' && config.pluginDefaultsGeneration >= DEFAULTS_GENERATION) {
    return false
  }

  const plugins = Array.isArray(config.plugins) ? (config.plugins as PluginEntry[]) : []
  const present = new Set(plugins.map((entry) => parseSpec(String(entry.spec)).package))
  const added = DEFAULT_PLUGIN_SPECS.filter((spec) => !present.has(parseSpec(spec).package)).map((spec) => ({ spec }))

  config.plugins = [...plugins, ...added]
  config.pluginDefaultsGeneration = DEFAULTS_GENERATION
  try {
    writeFileSync(file, `${JSON.stringify(config, undefined, 2)}\n`)
  } catch {
    // An unwritable config is the user's to fix; the default simply is not
    // added, and the marker is not recorded, so the next launch retries.
    return false
  }
  return added.length > 0
}
