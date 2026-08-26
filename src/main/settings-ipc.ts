import type { BinaryChecks } from './check-binaries'
import type { ConfigResult, DesktopConfig } from './config'
import { isConfigurationProblem, summarizeConfigurationNeed, summarizeFailure } from './error-summary'
import type { OpenConfigFileResult } from './open-config-file'
import { MCP_PRESETS, type McpPreset } from './mcp-presets'
import { activeServers, MCP_CLIENT_PACKAGE, type McpConfig } from './mcp-servers'
import { parseSpec, type PluginEntry } from './plugin-entries'
import {
  formFor,
  parsePluginConfig,
  validatePluginSpec,
  validateSettings,
  type FieldErrors,
  type PluginConfigValidation,
  type PluginSpecValidation,
  type SettingsForm,
} from './settings-validate'

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
  /**
   * Verify the Advanced tab's `pnpm`/`npm` path fields actually spawn,
   * against the values currently typed in the form — never the saved
   * config, and never written to disk. Reads nothing from `readConfig` and
   * calls neither `writeConfig` nor `apply`.
   * @param pnpmPath - the pnpm path field's current value; blank means PATH.
   * @param npmPath - the npm path field's current value; blank means PATH.
   */
  checkBinaries(pnpmPath: string, npmPath: string): Promise<BinaryChecks>
  /**
   * Why each currently-configured plugin is not mounted in the harness the
   * app has running right now, keyed by package name; a package absent from
   * the result is mounted (or was never configured). Reflects the outcome of
   * whatever boot last concluded, in the main process, independent of
   * whether any Settings window was open when it happened — so a window
   * opened well after boot still shows an accurate reason.
   */
  disabledPlugins(): Record<string, string>
  /**
   * Why a currently-mounted plugin's browser half did not load, keyed by
   * package name — distinct from `disabledPlugins`: an entry here is still
   * mounted (its tools work) but `plugin-link.ts`'s `ensurePluginLink`
   * could not link it into the profile's `node_modules` by its bare
   * package name, which is the only way
   * `@deepseek-ai/dsh-client-modules`' `ClientModuleRegistry` ever
   * discovers a plugin's browser bundle. A package absent from the result
   * either has no declared browser half (`plugin-entries.ts`'s
   * `declaresClientHalf`) or linked successfully.
   */
  clientLinkWarnings(): Record<string, string>
  /**
   * Open `desktop.json` in whatever the OS associates with `.json` files, for
   * manual editing.
   *
   * Never writes the file: a first-run app that has never saved has nothing
   * on disk yet (see `loadConfig`'s ENOENT-only handling), and this reports
   * that rather than seeding a file the user never asked to create. Reading
   * or writing the running config is otherwise `readConfig`/`writeConfig`'s
   * job alone; this never becomes a third way into that surface.
   */
  openConfigFile(): Promise<OpenConfigFileResult>
  /**
   * The store holding each MCP server's token, outside `desktop.json` and
   * outside the settings form (see `secrets.ts`). Injected as a whole rather
   * than as loose functions so tests can substitute one that writes nowhere.
   */
  mcpSecrets: {
    /**
     * Whether a token is on file, without decrypting it.
     * @param id - the server id.
     * @returns whether a token is stored.
     */
    has(id: string): boolean
    /**
     * Store one server's token.
     * @param id - the server id.
     * @param value - the token.
     */
    set(id: string, value: string): void
    /**
     * Forget one server's token.
     * @param id - the server id.
     */
    clear(id: string): void
    /**
     * Drop every stored token whose server no longer exists.
     * @param keep - the server ids that survive.
     */
    reconcile(keep: ReadonlySet<string>): void
  }
  /**
   * Respawn the harness child, for a change that alters what the child was
   * launched with but leaves `desktop.json` untouched — replacing a stored
   * token, whose value reaches the harness only through the child's
   * environment (see `index.ts`'s `mcpEnv`). `apply` cannot serve here: it
   * compares two configs, and these two are equal.
   */
  restartHarness(): Promise<void>
}

/** What `read` reports about the MCP tab's own state, alongside the editable form. */
export interface McpInfo {
  /**
   * Which configured servers have a token on file, by id. The token itself
   * is never sent to the renderer — only whether one exists — so a stored
   * credential cannot be read back out through the settings window.
   */
  tokens: Record<string, boolean>
  /**
   * The shipped catalog, sent to the renderer rather than duplicated there:
   * the settings window needs each entry's label, URL, docs link, and
   * whether it can be added at all, and a second copy of that table would be
   * one more thing to keep in step with `mcp-presets.ts`.
   */
  presets: readonly McpPreset[]
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
  /** The entry's stored config, pretty-printed for the row's textarea; `''` when none is set. */
  config: string
  /**
   * Why this plugin is not mounted in the harness right now — the harness's
   * own message when a boot isolated it after attributing a runtime failure
   * to it, or the pre-flight reason (not installed, not loadable, …) when it
   * never reached the overlay at all. Undefined when the plugin is mounted.
   *
   * This is the full, raw text — often a multi-level stack trace — kept
   * available for a Settings row's expander. `disabledSummary` is what the
   * row shows by default; see `error-summary.ts`'s `summarizeFailure`.
   */
  disabledReason?: string
  /**
   * The one-sentence extract of `disabledReason` the row shows by default.
   * Always present when `disabledReason` is, computed by `summarizeFailure`
   * — never the harness's raw, thousands-of-characters text.
   */
  disabledSummary?: string
  /**
   * How the row should present `disabledReason`, when present. `'needs-configuration'`
   * is a setup step — cordis's own `ValidationError` rejecting this entry's
   * `config` (missing or shaped wrong) — presented calmly with a pointer to
   * the row's own Config editor. `'failed'` is everything else (module
   * resolution, a runtime throw, an unfamiliar error shape) and stays the
   * loud, danger-toned presentation. Always present when `disabledReason` is;
   * see `error-summary.ts`'s `isConfigurationProblem`.
   */
  disabledKind?: 'needs-configuration' | 'failed'
  /**
   * Set only when this plugin is mounted (its tools work) but its browser
   * half is not: it declares one (`dsh.client.platform` in its own
   * `package.json`) and `ensurePluginLink` could not link it by name, the
   * only way the harness's client-module registry ever discovers it. From
   * `SettingsDeps.clientLinkWarnings`.
   */
  clientWarning?: string
}

/** Outcome of a save attempt. `warnings` carries non-blocking problems, such as a rejected hotkey. */
export type SaveResult = { ok: true; warnings: string[] } | { ok: false; errors: FieldErrors }

/**
 * Outcome of accepting one plugin's offered update.
 *
 * On success, `version` is the concrete version `installPlugin` actually
 * resolved and wrote to config — not assumed to equal the version the
 * renderer requested. `resolveVersion` treats its input as a spec to
 * re-resolve, not an already-final answer, so the two can differ if the
 * registry moves between the update check and the accept; returning it
 * explicitly is what lets the row on screen show what was actually
 * installed rather than an assumption about the wire round-trip.
 */
export type AcceptPluginUpdateResult =
  | { ok: true; warnings: string[]; version: string }
  | { ok: false; errors: FieldErrors }

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
  ): { configured: boolean; form: SettingsForm; plugins: PluginInfo[]; mcp: McpInfo }
  pickFolder(): Promise<string | undefined>
  /**
   * Saves one form: validates it and writes it to disk unconditionally
   * (never refused for overlapping another save), then installs its plugins
   * and applies it to the running app.
   *
   * The install-and-apply step is serialized across every call to `save` and
   * `acceptPluginUpdate` with latest-wins semantics: at most one is ever
   * installing or applying at a time, and a call queued behind one already
   * running is superseded by the next call to arrive rather than running in
   * its own turn — so a config written but never applied because a later one
   * superseded it is still exactly what is on disk, just not (yet, or ever,
   * if superseded again) reflected in the running app. The returned
   * `warnings` are this call's own install/apply outcome when it actually
   * ran, or empty when it was superseded before running.
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
   * same as before. Writes immediately, the same as `save`; its own install
   * and apply share `save`'s latest-wins queue, so two of these (or one of
   * these and a `save`) never install or apply concurrently.
   * @param pkg - the package name (not the raw spec) naming which entry to update.
   * @param version - the concrete version to install and store, from the
   *   update-available push this answers.
   * @param onProgress - called with each line of `npm install` output.
   * @returns the outcome; on success, carries the concrete version actually installed and stored.
   */
  acceptPluginUpdate(pkg: string, version: string, onProgress?: (line: string) => void): Promise<AcceptPluginUpdateResult>
  /**
   * Validate one freshly typed plugin spec for the Settings window's
   * row-based Add control, synchronously and without installing anything.
   *
   * This is the row-based control's only access to the spec grammar: the
   * renderer holds no copy of `validSpecShape`/`parseSpec`, so a change to
   * that grammar cannot drift between what Add accepts and what Save later
   * re-validates.
   * @param spec - the raw text typed into the Add input.
   * @param existingPackages - package names of the rows already added, so a
   *   duplicate is rejected here rather than only surfacing at Save.
   * @returns the parsed entry to add as a row, or the message to show beside the input.
   */
  validatePlugin(spec: string, existingPackages: string[]): PluginSpecValidation
  /**
   * Validate one plugin row's config textarea, synchronously and without
   * installing or persisting anything — the row-based control's live check
   * on blur, over the same grammar `save` re-checks in `parsePluginsField`.
   * @param text - the raw textarea contents.
   * @returns ok, or the message to show beside that row.
   */
  validatePluginConfig(text: string): PluginConfigValidation
  /**
   * Verify the Advanced tab's `pnpm`/`npm` path fields actually spawn, using
   * the values currently typed in the form. Bypasses `save`'s install/apply
   * queue entirely: this reads and writes nothing, so it can run freely
   * alongside a save already installing or applying, without racing it.
   * @param pnpmPath - the pnpm path field's current value; blank means PATH.
   * @param npmPath - the npm path field's current value; blank means PATH.
   * @returns both binaries' outcomes.
   */
  checkBinaries(pnpmPath: string, npmPath: string): Promise<BinaryChecks>
  /**
   * Open `desktop.json` for manual editing. Bypasses `save`'s install/apply
   * queue, like `checkBinaries`: this reads and writes nothing
   * settings-owned, so it can run freely alongside a save already in flight.
   * @returns ok, or a diagnosable error — including "nothing has been saved
   *   yet" for a config that has never been written.
   */
  openConfigFile(): Promise<OpenConfigFileResult>
  /**
   * Store one MCP server's token and respawn the harness so it takes effect.
   *
   * Separate from `save` because a token is not part of the form and never
   * reaches `desktop.json`: it goes to its own file (see `secrets.ts`), and
   * the running harness only picks it up through a restart.
   * @param id - the server id the token belongs to.
   * @param token - the token as typed; blank is rejected rather than stored.
   * @returns whether it was stored, and why not when it was not.
   */
  setMcpToken(id: string, token: string): Promise<{ ok: boolean; message?: string }>
  /**
   * Forget one MCP server's token and respawn the harness without it.
   * @param id - the server id.
   * @returns whether it was cleared, and why not when it was not.
   */
  clearMcpToken(id: string): Promise<{ ok: boolean; message?: string }>
}

/**
 * Build the settings handlers over injected dependencies.
 *
 * Validation runs before anything is written, so a rejected save never leaves
 * a partial config on disk. Beyond that, a save always writes — never
 * refused for overlapping another — and only the install-and-apply work that
 * follows is serialized; see `scheduleJob`.
 * @param deps - collaborators supplied by the main process.
 * @returns the handler set the IPC channels delegate to.
 */
export function createSettingsHandlers(deps: SettingsDeps): SettingsHandlers {
  /**
   * The config last actually handed to `deps.apply`, i.e. what the running
   * app reflects right now — distinct from what `deps.readConfig()` reports,
   * which a save's own immediate write can race ahead of while its
   * install-and-apply job is still queued behind another. Seeded from disk:
   * at the moment these handlers are built, whatever is stored is what the
   * app is about to boot, or has already booted, with.
   *
   * Updated only inside `installAndApply`/`performAcceptPluginUpdate`, right
   * after their own `deps.apply` call resolves — never from a fast write —
   * so a config written but not yet (or never, if superseded) applied is
   * never mistaken for the one actually running.
   */
  let appliedConfig: DesktopConfig | undefined = (() => {
    const stored = deps.readConfig()
    return stored.configured ? stored.config : undefined
  })()

  /**
   * The single in-flight install-and-apply job, and the one waiting behind
   * it, shared by every caller of `scheduleJob` — `save` and
   * `acceptPluginUpdate` alike.
   *
   * At most one job ever runs at a time: this is what keeps two overlapping
   * saves, or a save and an `acceptPluginUpdate`, from spawning two harness
   * children or running two `npm install`s into the same target directory
   * concurrently. A job queued behind one already running is never run in
   * its own turn — the next call to arrive replaces it outright, so only the
   * latest submission's install-and-apply ever actually happens. This is
   * "latest wins": a superseded call's caller still has its own write
   * durable on disk (that already happened before `scheduleJob` was ever
   * called — see `performSave`), it just has no install/apply outcome of its
   * own to report.
   */
  let runningJob: Promise<void> | undefined
  let queuedJob: { run(): Promise<void>; supersede(): void } | undefined

  /**
   * Start the queued job if nothing is running, and keep draining the queue
   * as each job finishes and clears the way for whatever arrived next.
   */
  function drain(): void {
    if (runningJob !== undefined) return
    const job = queuedJob
    if (job === undefined) return
    queuedJob = undefined
    runningJob = job.run().finally(() => {
      runningJob = undefined
      drain()
    })
  }

  /**
   * Submit install-and-apply work to the shared, single-flight queue.
   * @param run - performs the install(s) and apply, resolving with this call's own outcome.
   * @param onSuperseded - the outcome to resolve with instead, if a later
   *   submission replaces this one before it starts running.
   * @returns this call's own outcome, or `onSuperseded`'s if replaced first.
   */
  function scheduleJob<T>(run: () => Promise<T>, onSuperseded: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queuedJob?.supersede()
      // `run().then(resolve, reject)` forwards this call's own outcome —
      // success or failure alike — to its caller while itself always
      // fulfilling, so a rejection (e.g. `writeConfig` throwing) still
      // propagates to whoever called `scheduleJob` instead of leaving
      // `drain`'s chain, and therefore the whole queue, stuck on a rejected
      // `runningJob` nothing ever observes.
      queuedJob = { run: () => run().then(resolve, reject), supersede: () => resolve(onSuperseded()) }
      drain()
    })
  }

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
        resolved.push({ spec: entry.spec, version: concrete, ...(entry.config === undefined ? {} : { config: entry.config }) })
      } catch (error) {
        warnings.push(`${pkg} could not be installed: ${(error as Error).message}`)
        resolved.push({ spec: entry.spec, version: prior?.version, ...(entry.config === undefined ? {} : { config: entry.config }) })
      }
    }
    return { resolved, warnings }
  }

  /**
   * Install `config`'s plugins, persist their resolved versions, and apply
   * the result to the running app. Runs only from inside `scheduleJob`'s
   * queue, so it can assume no other install or apply is active.
   * @param priorPlugins - the entries to reuse or fall back to for version resolution — see `installPlugins`.
   * @param config - the config already written to disk by `performSave`, with unresolved plugin versions.
   * @param onProgress - receives `npm install` output lines.
   * @returns this job's own warnings.
   */
  async function installAndApply(
    priorPlugins: PluginEntry[],
    config: DesktopConfig,
    onProgress?: (line: string) => void,
  ): Promise<{ warnings: string[] }> {
    if (deps.isQuitting()) return { warnings: [] }

    const { resolved, warnings: pluginWarnings } = await installPlugins(
      config.plugins ?? [],
      priorPlugins,
      config.npmPath,
      onProgress ?? (() => {}),
    )
    // The MCP client rides the same install path as a plugin entry — one
    // package, however many servers it backs — by being handed to
    // `installPlugins` as a one-entry list. It is installed only when a
    // server is actually enabled, so a user who never turns MCP on never
    // pays for the download, and its prior version is carried in as that
    // entry's `previous` so an unchanged section is a cache hit rather than
    // a reinstall on every save.
    const mcpWarnings: string[] = []
    let mcp = config.mcp
    if (mcp !== undefined && activeServers(mcp).length > 0) {
      const prior: PluginEntry[] =
        mcp.clientVersion === undefined ? [] : [{ spec: MCP_CLIENT_PACKAGE, version: mcp.clientVersion }]
      const installed = await installPlugins([{ spec: MCP_CLIENT_PACKAGE }], prior, config.npmPath, onProgress ?? (() => {}))
      mcpWarnings.push(...installed.warnings)
      const version = installed.resolved[0]?.version
      mcp = { ...mcp, ...(version === undefined ? {} : { clientVersion: version }) }
    }
    const resolvedConfig = { ...config, plugins: resolved, ...(mcp === undefined ? {} : { mcp }) }

    // An install can run for minutes; a quit landing during it must not still
    // land a write and an apply behind the quit's back once it finishes.
    if (deps.isQuitting()) return { warnings: pluginWarnings }

    deps.writeConfig(resolvedConfig)
    const applyWarnings = await deps.apply(appliedConfig, resolvedConfig)
    appliedConfig = resolvedConfig
    return { warnings: [...pluginWarnings, ...mcpWarnings, ...applyWarnings] }
  }

  /**
   * Validate one settings form and write it to disk — installing the
   * plugins it configures, and applying the result to the running app, is
   * deferred to a queued job (see `installAndApply`/`scheduleJob`) rather
   * than done here, so this always finishes quickly.
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

    // The managed harness's own version must be a concrete version, never a
    // dist-tag `resolveVersion` would re-resolve differently later, and
    // `HarnessSource.version` is not optional — unlike a plugin entry, there
    // is no "not installed yet" state this field can be left in. Installing
    // it therefore stays here rather than moving to the deferred job below:
    // a harness source change is rare, and — like every managed install —
    // already bounded by `INSTALL_TIMEOUT_MS`.
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

    // A save arriving while quitting is refused above; the harness install
    // can run for minutes, so quitting is re-checked here too — otherwise a
    // quit during a long install would still land a write behind its back
    // once the install finishes.
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

    // Plugin entries are written as submitted, minus installing them: an
    // unchanged spec keeps its previously resolved version, and a new or
    // changed one is left unresolved until the queued job installs it.
    // `PluginEntry.version` is already optional for exactly this state (see
    // its own doc) — `pluginStatus` already reports it as "not installed
    // yet" rather than failing boot — so this writes nothing the rest of the
    // app cannot already handle. This is what lets a save that only removes
    // or reorders rows write immediately, with no install in its way at all.
    const priorPlugins = previous?.plugins ?? []
    const provisionalPlugins = (config.plugins ?? []).map((entry) => {
      const prior = priorPlugins.find((candidate) => candidate.spec === entry.spec)
      return prior === undefined ? entry : { ...entry, version: prior.version }
    })
    config = { ...config, plugins: provisionalPlugins }

    // The MCP client's resolved version is carried forward for the same
    // reason a plugin entry's is: the queued job below resolves it, and a
    // save that only toggled a server must not drop the version already
    // installed and make the next boot report it as missing.
    if (config.mcp !== undefined) {
      const priorVersion = previous?.mcp?.clientVersion
      config = {
        ...config,
        mcp: { ...config.mcp, ...(priorVersion === undefined ? {} : { clientVersion: priorVersion }) },
      }
    }

    deps.writeConfig(config)

    // A token outliving the server it belonged to would come back silently
    // if the id were ever reused, so stored tokens are reconciled against
    // what was just saved — after the write, so a failed save never discards
    // a credential for a server that is still configured.
    deps.mcpSecrets.reconcile(new Set((config.mcp?.servers ?? []).map((server) => server.id)))

    const { warnings } = await scheduleJob(
      () => installAndApply(priorPlugins, config, onProgress),
      () => ({ warnings: [] }),
    )
    return { ok: true, warnings }
  }

  /**
   * Store one server's token, then respawn the harness so the child is
   * launched with it.
   *
   * The restart is deliberate and unconditional on success: the token
   * reaches the harness only through the environment its child was spawned
   * with, so without one the user would save a token and see nothing change.
   * @param id - the server id.
   * @param token - the token as typed.
   * @returns whether it was stored, and why not when it was not.
   */
  async function performSetMcpToken(id: string, token: string): Promise<{ ok: boolean; message?: string }> {
    if (deps.isQuitting()) return { ok: false, message: 'The app is shutting down.' }
    const trimmed = token.trim()
    if (trimmed === '') return { ok: false, message: 'Enter a token, or use Remove to clear the stored one.' }
    try {
      deps.mcpSecrets.set(id, trimmed)
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
    await deps.restartHarness()
    return { ok: true }
  }

  /**
   * Forget one server's token and respawn the harness without it.
   * @param id - the server id.
   * @returns whether it was cleared, and why not when it was not.
   */
  async function performClearMcpToken(id: string): Promise<{ ok: boolean; message?: string }> {
    if (deps.isQuitting()) return { ok: false, message: 'The app is shutting down.' }
    deps.mcpSecrets.clear(id)
    await deps.restartHarness()
    return { ok: true }
  }

  /**
   * Install `version` for `pkg`'s already-configured floating entry, then
   * persist and apply just that one field change — `spec` is never touched,
   * which is what keeps the entry floating rather than silently pinning it
   * the way writing `pkg@version` into its spec would. Runs only from inside
   * `scheduleJob`'s queue, so it can assume no other install or apply is
   * active.
   * @param pkg - the package name identifying which entry to update.
   * @param version - the version to install and store.
   * @param onProgress - receives `npm install` output lines.
   * @returns the outcome.
   */
  async function performAcceptPluginUpdate(
    pkg: string,
    version: string,
    onProgress?: (line: string) => void,
  ): Promise<AcceptPluginUpdateResult> {
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

    const updatedEntries = entries.map((entry, i) =>
      i === index ? { spec: entry.spec, version: concrete, ...(entry.config === undefined ? {} : { config: entry.config }) } : entry,
    )
    const config: DesktopConfig = { ...previous, plugins: updatedEntries }
    deps.writeConfig(config)
    const warnings = await deps.apply(appliedConfig, config)
    appliedConfig = config
    return { ok: true, warnings, version: concrete }
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

      // Filtered rather than shown as a broken row: this app manages that
      // package on the MCP tab, so a stored entry for it is residue from a
      // hand edit or a save predating that tab. The next save drops it from
      // disk for good (see `settings-validate.ts`); until then it must not
      // appear here offering a Config editor for something the user is not
      // the one configuring.
      const storedPlugins = (stored.configured ? (stored.config.plugins ?? []) : []).filter(
        (entry) => parseSpec(entry.spec).package !== MCP_CLIENT_PACKAGE,
      )
      const disabled = deps.disabledPlugins()
      const clientWarnings = deps.clientLinkWarnings()
      const plugins: PluginInfo[] = storedPlugins.map((entry) => {
        const { package: pkg, pinnedVersion } = parseSpec(entry.spec)
        const disabledReason = disabled[pkg]
        const needsConfiguration = disabledReason !== undefined && isConfigurationProblem(disabledReason)
        return {
          spec: entry.spec,
          package: pkg,
          pinned: pinnedVersion !== undefined,
          version: entry.version,
          config: entry.config === undefined ? '' : JSON.stringify(entry.config, undefined, 2),
          disabledReason,
          disabledSummary:
            disabledReason === undefined
              ? undefined
              : needsConfiguration
                ? summarizeConfigurationNeed(disabledReason)
                : summarizeFailure(disabledReason),
          disabledKind: disabledReason === undefined ? undefined : needsConfiguration ? 'needs-configuration' : 'failed',
          clientWarning: clientWarnings[pkg],
        }
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

      const storedMcp = stored.configured ? stored.config.mcp : undefined
      const tokens: Record<string, boolean> = {}
      for (const server of storedMcp?.servers ?? []) tokens[server.id] = deps.mcpSecrets.has(server.id)

      return {
        configured: stored.configured,
        form: formFor(stored),
        plugins,
        mcp: { tokens, presets: MCP_PRESETS },
      }
    },
    pickFolder: () => deps.pickFolder(),
    save: (form, onProgress) => performSave(form, onProgress),
    acceptPluginUpdate: (pkg, version, onProgress) =>
      scheduleJob(
        () => performAcceptPluginUpdate(pkg, version, onProgress),
        () => ({
          ok: false,
          errors: {
            kind: `${pkg} was not updated — a newer settings change was applied instead. Try again if you still want this update.`,
          },
        }),
      ),
    validatePlugin: (spec, existingPackages) => validatePluginSpec(spec, existingPackages),
    validatePluginConfig: (text) => parsePluginConfig(text),
    checkBinaries: (pnpmPath, npmPath) => deps.checkBinaries(pnpmPath, npmPath),
    openConfigFile: () => deps.openConfigFile(),
    setMcpToken: (id, token) => performSetMcpToken(id, token),
    clearMcpToken: (id) => performClearMcpToken(id),
  }
}
