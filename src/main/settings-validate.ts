import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { DEFAULT_HOTKEY, DEFAULT_NOTIFY_PORT, type ConfigResult, type DesktopConfig } from './config'
import type { HarnessSource } from './harness-source'
import { MCP_CLIENT_PACKAGE } from './mcp-servers'
import { defaultPlugins, parseSpec, validSpecShape, type PluginEntry } from './plugin-entries'

/** The settings form's raw values. Every field is a string because HTML forms yield strings. */
export interface SettingsForm {
  kind: 'local' | 'managed'
  repo: string
  package: string
  version: string
  workspace: string
  notifyPort: string
  hotkey: string
  pnpmPath: string
  npmPath: string
  /**
   * Extra `PATH` entries for the harness child, colon-separated. Blank means
   * none, and writes no `extraPath` at all.
   */
  extraPath: string
  /**
   * One row per configured plugin, built by the renderer from its row-based
   * Add control — not raw HTML field values, unlike every other member of
   * this interface. `spec` is typed the way the user would on a command
   * line: `pkg@version` (pinned) or `pkg` (floating). `config` is the row's
   * own free-form configuration textarea, raw JSON text; blank means no
   * config. A row with a blank `spec` is ignored, the same as a blank line
   * was in the free-text field this replaced. `settings-ipc.ts`'s
   * `performSave` resolves and installs each row and reconciles it against
   * the previously stored entries.
   */
  plugins: { spec: string; config: string }[]
  /**
   * Whether MCP servers are mounted at all.
   *
   * Only the switch travels through the form: the servers themselves live in
   * `mcp.json` and are saved through their own channel, because that file is
   * the portable one and `save` writes `desktop.json`.
   */
  mcpEnabled: boolean
}

/** Per-field messages for a rejected form; absent keys validated cleanly. */
export type FieldErrors = Partial<Record<keyof SettingsForm, string>>

/** A validated config, or the reasons the form was rejected. */
export type ValidationResult =
  | { ok: true; config: DesktopConfig }
  | { ok: false; errors: FieldErrors }

/** Default published package used when the form leaves it blank on a first run. */
const DEFAULT_PACKAGE = '@deepseek-ai/dsh'
/** Default dist-tag when no version is given. */
const DEFAULT_VERSION = 'latest'

/**
 * Shape of a valid (optionally scoped) npm package name.
 * Deliberately narrower than npm's full grammar: it exists to keep this
 * free-text field from reaching `managedDir` as a path-traversal or
 * multi-segment string, not to validate every legal npm name.
 */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Shape of a valid version or dist-tag (e.g. `1.2.3`, `0.1.1-rc.2`, `latest`).
 * Like `PACKAGE_NAME_PATTERN`, this exists to keep the field from reaching
 * `managedDir` as a traversal or multi-segment string.
 */
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/

/** Result of validating one plugin's config textarea. */
export type PluginConfigValidation = { ok: true; config?: Record<string, unknown> } | { ok: false; message: string }

/**
 * Parse and validate one plugin row's free-form config text.
 *
 * The config is inherently free-form — only the plugin itself knows its own
 * schema — so JSON is the wire format rather than a key/value UI that could
 * never express nesting. Blank text means "no config", which keeps the
 * overlay's current `{}` behaviour (see `runtime-files.ts`'s `patchOverlay`).
 * @param text - the raw textarea contents.
 * @returns the parsed object, or the message to show beside that row.
 */
export function parsePluginConfig(text: string): PluginConfigValidation {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, config: undefined }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, message: `Config is not valid JSON: ${(error as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'Config must be a JSON object, e.g. {"key": "value"}.' }
  }
  return { ok: true, config: parsed as Record<string, unknown> }
}

/**
 * Parse the `plugins` field — one row per configured plugin, accumulated
 * from the Settings window's row-based Add control — into entries, or the
 * reason a row was rejected.
 *
 * A row with a blank `spec` is skipped, the same as a blank line was in the
 * free-text field this replaced. A duplicate package name (pinned or not) is
 * rejected rather than silently keeping one. In normal use the row-based
 * control already rejects a duplicate spec at Add time (see
 * `validatePluginSpec` below) and a bad config on blur (see
 * `parsePluginConfig`), so this is a second check on the accumulated list at
 * Save. A config parse failure is reported against the package it belongs
 * to, not as a field-wide error, since more than one row could be at fault.
 * @param rows - the row-based field contents.
 * @returns the parsed entries, or an error message naming the bad row.
 */
function parsePluginsField(rows: { spec: string; config: string }[]): { ok: true; entries: PluginEntry[] } | { ok: false; message: string } {
  const seen = new Set<string>()
  const entries: PluginEntry[] = []
  for (const row of rows) {
    const spec = row.spec.trim()
    if (spec === '') continue
    if (!validSpecShape(spec)) {
      return { ok: false, message: `"${spec}" does not look like a package name, package@version, or a valid version.` }
    }
    const { package: pkg } = parseSpec(spec)
    if (seen.has(pkg)) {
      return { ok: false, message: `${pkg} is listed more than once.` }
    }
    seen.add(pkg)
    const config = parsePluginConfig(row.config)
    if (!config.ok) {
      return { ok: false, message: `${pkg}: ${config.message}` }
    }
    entries.push({ spec, ...(config.config === undefined ? {} : { config: config.config }) })
  }
  return { ok: true, entries }
}

/**
 * The row-based Add control's view of one freshly added plugin: everything
 * the renderer needs to draw a row without parsing the spec itself.
 */
export interface ValidatedPlugin {
  /** As typed by the user. */
  spec: string
  /** The parsed package name. */
  package: string
  /** True when the spec carried `@version`. */
  pinned: boolean
}

/** Result of validating one plugin spec for the row-based Add control. */
export type PluginSpecValidation = { ok: true; plugin: ValidatedPlugin } | { ok: false; message: string }

/**
 * Validate one freshly typed plugin spec before it becomes a row.
 *
 * Reuses `validSpecShape`/`parseSpec` — the same grammar `parsePluginsField`
 * applies at Save — so a spec accepted here is guaranteed to be accepted
 * again when the accumulated list is submitted, and so the renderer never
 * needs its own copy of that grammar to display the package name or pinned
 * state: this function hands both back already parsed. This is the only
 * place the grammar is checked outside `parsePluginsField`.
 * @param spec - the raw text typed into the Add input.
 * @param existingPackages - package names already present in the list, so a
 *   spec naming one of them is rejected here instead of only at Save.
 * @returns the parsed plugin to add as a row, or the message to show beside the input.
 */
export function validatePluginSpec(spec: string, existingPackages: string[]): PluginSpecValidation {
  const trimmed = spec.trim()
  if (trimmed === '') return { ok: false, message: 'Enter a package name to add.' }
  if (!validSpecShape(trimmed)) {
    return {
      ok: false,
      message: `"${trimmed}" does not look like a package name, package@version, or a valid version.`,
    }
  }
  const { package: pkg, pinnedVersion } = parseSpec(trimmed)
  if (pkg === MCP_CLIENT_PACKAGE) {
    return {
      ok: false,
      message: 'This app manages that package itself — add MCP servers on the MCP tab instead.',
    }
  }
  if (existingPackages.includes(pkg)) {
    return { ok: false, message: `${pkg} is already in the list.` }
  }
  return { ok: true, plugin: { spec: trimmed, package: pkg, pinned: pinnedVersion !== undefined } }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Any failure to stat — absent, unreadable, or a broken link — means this
    // is not a usable folder, which is the only distinction the form needs.
    return false
  }
}

/**
 * Validate a submitted form and convert it into stored settings.
 *
 * Every field is checked, so the form can show all its problems at once
 * rather than one per submission.
 * @param form - the raw form values.
 * @returns the resulting config, or per-field errors.
 */
export function validateSettings(form: SettingsForm): ValidationResult {
  const errors: FieldErrors = {}

  let harness: HarnessSource | undefined
  if (form.kind === 'local') {
    const repo = form.repo.trim()
    if (repo === '') {
      errors.repo = 'A harness checkout folder is required.'
    } else if (!isDirectory(repo)) {
      errors.repo = 'That path is not a folder on this machine.'
    } else {
      harness = { kind: 'local', repo }
    }
  } else {
    const pkg = form.package.trim()
    const workspace = form.workspace.trim()
    const version = form.version.trim() === '' ? DEFAULT_VERSION : form.version.trim()
    if (pkg === '') {
      errors.package = 'A package name is required.'
    } else if (!PACKAGE_NAME_PATTERN.test(pkg)) {
      errors.package = 'That does not look like an npm package name.'
    }
    if (!VERSION_PATTERN.test(version)) {
      errors.version = 'That does not look like a version or dist-tag.'
    }
    if (workspace !== '' && !isDirectory(workspace)) {
      errors.workspace = 'That path is not a folder on this machine.'
    }
    if (errors.package === undefined && errors.version === undefined && errors.workspace === undefined) {
      harness = {
        kind: 'managed',
        package: pkg,
        version,
        workspace: workspace === '' ? homedir() : workspace,
      }
    }
  }

  const notifyPort = Number(form.notifyPort.trim())
  if (!Number.isInteger(notifyPort) || notifyPort < 1 || notifyPort > 65535) {
    errors.notifyPort = 'Enter a port between 1 and 65535.'
  }

  const hotkey = form.hotkey.trim()
  if (hotkey === '') errors.hotkey = 'A shortcut is required.'

  // The MCP client is this app's own, configured on the MCP tab: one package
  // backing however many servers, with a config only that tab can produce. A
  // bare entry for it in the plugin list has no config, which cordis rejects
  // at load — so it is dropped here rather than being carried into the boot
  // that would fail on it. `validatePluginSpec` refuses to add it in the
  // first place; this is what clears one that a hand-edited `desktop.json`,
  // or a save from before the MCP tab existed, already stored.
  const parsedPlugins = parsePluginsField(
    form.plugins.filter((row) => parseSpec(row.spec.trim()).package !== MCP_CLIENT_PACKAGE),
  )
  if (!parsedPlugins.ok) errors.plugins = parsedPlugins.message

  if (harness === undefined || Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }

  const pnpmPath = form.pnpmPath.trim()
  const npmPath = form.npmPath.trim()
  const extraPath = form.extraPath.trim()
  return {
    ok: true,
    config: {
      harness,
      notifyPort,
      hotkey,
      // Each entry's `version` is resolved and installed by
      // `settings-ipc.ts`'s `performSave`, which also reconciles this fresh
      // parse against the previously stored entries to carry forward an
      // already-resolved version for a spec that has not changed.
      plugins: parsedPlugins.ok ? parsedPlugins.entries : [],
      ...(form.mcpEnabled ? { mcpEnabled: true } : {}),
      ...(pnpmPath === '' ? {} : { pnpmPath }),
      ...(npmPath === '' ? {} : { npmPath }),
      ...(extraPath === '' ? {} : { extraPath }),
    },
  }
}

/**
 * Fill the form from stored settings, or with defaults on a first run.
 * @param result - what `loadConfig` returned.
 * @returns form values ready to render.
 */
export function formFor(result: ConfigResult): SettingsForm {
  const base: SettingsForm = {
    kind: 'local',
    repo: '',
    package: DEFAULT_PACKAGE,
    version: DEFAULT_VERSION,
    workspace: '',
    notifyPort: String(DEFAULT_NOTIFY_PORT),
    hotkey: DEFAULT_HOTKEY,
    pnpmPath: '',
    npmPath: '',
    extraPath: '',
    // A never-configured install pre-seeds the notification hook bridge as
    // the first plugin, so the first save installs it rather than special-
    // casing it outside this generic list.
    plugins: defaultPlugins().map((entry) => ({ spec: entry.spec, config: '' })),
    // Off by default: MCP is opt-in, and a fresh install must not reach any
    // third-party server on its own.
    mcpEnabled: false,
  }
  if (!result.configured) return base

  const { harness, notifyPort, hotkey, pnpmPath, npmPath, extraPath, plugins, mcpEnabled } = result.config
  return {
    ...base,
    kind: harness.kind,
    ...(harness.kind === 'local'
      ? { repo: harness.repo }
      : { package: harness.package, version: harness.version, workspace: harness.workspace }),
    notifyPort: String(notifyPort),
    hotkey,
    pnpmPath: pnpmPath ?? '',
    npmPath: npmPath ?? '',
    extraPath: extraPath ?? '',
    plugins: (plugins ?? []).map((entry) => ({
      spec: entry.spec,
      config: entry.config === undefined ? '' : JSON.stringify(entry.config, undefined, 2),
    })),
    mcpEnabled: mcpEnabled === true,
  }
}
