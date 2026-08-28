// Dumb form: reads values, sends them to main, renders whatever comes back.
// All validation lives in the main process.
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npmPath', 'extraPath', 'terminalShell']
const el = (id) => document.getElementById(id)
const kindOf = () => document.querySelector('input[name="kind"]:checked').value

// The tab ids, in tab-bar order, and which panel each Save-rejectable key's
// error belongs to. `plugin-spec` is absent — it is validated on Add, not
// Save, and never appears in a save result — so an Add error never drives a
// tab switch; `plugins` names the accumulated-list error Save can still
// return (see `error-plugins` in the Plugins panel).
const TABS = ['harness', 'plugins', 'mcp', 'notifications', 'advanced']
const FIELD_TAB = {
  repo: 'harness',
  package: 'harness',
  version: 'harness',
  workspace: 'harness',
  notifyPort: 'notifications',
  hotkey: 'notifications',
  pnpmPath: 'advanced',
  npmPath: 'advanced',
  extraPath: 'advanced',
  terminalShell: 'advanced',
  plugins: 'plugins',
  mcp: 'mcp',
}

let activeTab = 'harness'

/**
 * Activate one tab: show its panel, hide the rest, move the roving
 * `tabIndex`, and set `aria-selected` for assistive tech. Real semantics —
 * not a div that only reacts to clicks — so a screen reader announces the
 * selection change and arrow-key navigation (wired below) works natively.
 * @param {string} id - the tab id to activate.
 * @param {{ focus?: boolean }} [options] - `focus: false` activates without
 *   moving keyboard focus, used when Save redirects the user to the tab that
 *   holds the field it rejected without stealing focus from the Save button.
 */
function selectTab(id, options) {
  const focus = options === undefined || options.focus !== false
  activeTab = id
  for (const tab of TABS) {
    const button = el(`tab-${tab}`)
    const panel = el(`panel-${tab}`)
    const isActive = tab === id
    button.setAttribute('aria-selected', String(isActive))
    button.tabIndex = isActive ? 0 : -1
    panel.hidden = !isActive
  }
  if (focus) el(`tab-${id}`).focus()
}

/**
 * Show or clear the error dot on one tab's button, so a field error on a
 * panel that is not currently shown stays discoverable instead of vanishing
 * behind the inactive tab.
 * @param {string} id - the tab id.
 * @param {boolean} hasError - whether that tab's panel holds a live error.
 */
function markTabError(id, hasError) {
  el(`tab-${id}-error-dot`).hidden = !hasError
}

// The plugin rows currently shown, in display order, each `{ spec, package,
// pinned, version }` — `version` is undefined until a save has installed the
// entry at least once. Populated from `read()` on load and appended to by
// `addPlugin`; never edited as free text, only added to or removed from.
let pluginRows = []

// The MCP servers currently shown, in display order, as `mcp.json` holds
// them. Read through their own channel on load and written back through it
// on every change — they are deliberately not part of the form, because the
// form is what `save` persists into desktop.json.
let mcpServers = []
/** The projects the harness has opened, most recently used first. */
let workspaces = []
/** Whether a write to a project's own mcp.json is in flight. */
let projectWriting = false

// The shipped preset catalog, from `read()` rather than duplicated here.
let mcpPresets = []

// A server whose probe failed and which "Add anyway" would write regardless.
// Cleared on every new attempt, so the button can never write a stale entry.
let pendingServer

// Updates offered but not yet accepted, keyed by package name so any number
// of floating plugins can each carry their own pending update at once — a
// single shared hint element would let a second push silently overwrite the
// first, leaving one update unreachable until Settings is reopened.
let pluginUpdates = new Map()

// True for the duration of a `performSave` call. `performSave` reloads the
// whole plugin list from disk on success (see its own comment), which is
// only actually safe when nothing local can diverge from disk while it
// awaits — so Add, Remove, and "Use it" are all refused while this is true,
// the same way Save disables itself against a second Save. Without this, an
// Add or Remove landing during the minutes a managed install can take is
// silently lost or resurrected once the reload overwrites `pluginRows`.
let saveInFlight = false

/** Keep the Add button's disabled state in sync with both reasons it can be disabled. */
function refreshAddDisabled() {
  el('add-plugin').disabled = addingPlugin || saveInFlight
}

function showKind() {
  const managed = kindOf() === 'managed'
  el('local-fields').hidden = managed
  el('managed-fields').hidden = !managed
}

function clearErrors() {
  // Not every field has an error node: only the ones main can reject by name
  // do. The render loop already tolerates an absent node, and this is the same
  // fact, so it is tolerated the same way rather than by requiring the page to
  // carry a node per field forever. `kind` is not here: it is reported on the
  // status line, which `clearStatus` clears.
  for (const name of [...FIELDS, 'plugins']) {
    const target = el(`error-${name}`)
    if (target !== null) target.textContent = ''
  }
}

function clearStatus() {
  const status = el('status')
  status.textContent = ''
  status.classList.remove('status-warning')
  status.classList.remove('status-failed')
}

function clearProgress() {
  const progress = el('progress')
  progress.textContent = ''
  progress.hidden = true
}

function appendProgress(line) {
  const progress = el('progress')
  progress.hidden = false
  progress.textContent += (progress.textContent === '' ? '' : '\n') + line
  progress.scrollTop = progress.scrollHeight
}

/**
 * Hide the harness-source update hint (the one next to the Version field),
 * shown again only if `onUpdateAvailable` fires again.
 *
 * Scoped to that one hint only: it used to also clear every offered plugin
 * update, so saving anything unrelated — the hotkey, say — silently dropped
 * every pending plugin update hint before `onPluginUpdateAvailable` (pushed
 * once per `read`) could ever offer them again. Per-plugin hints are instead
 * reconciled by `load()`, which drops exactly the ones a fresh read shows as
 * already applied.
 */
function hideUpdateHint() {
  el('update-hint').hidden = true
}

function collect() {
  const form = { kind: kindOf() }
  for (const name of FIELDS) form[name] = el(name).value
  form.plugins = pluginRows.map((plugin) => ({ spec: plugin.spec, config: plugin.config ?? '' }))
  form.mcpEnabled = el('mcp-enabled').checked
  form.viewTools = el('view-tools').checked
  return form
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/**
 * Validate one row's config textarea on blur, over the same grammar Save
 * re-checks in main, and show its result beside that row only — never on the
 * field-wide `error-plugins` node, so one row's typo never has to be found
 * by reading a message about a package name that scrolled out of view.
 * @param {HTMLTextAreaElement} textarea - the row's config input.
 * @param {HTMLElement} errorNode - the row's own error paragraph.
 * @param {HTMLElement} summaryNode - the row's collapsible summary, relabelled to reflect whether config is set.
 */
async function validatePluginConfigRow(textarea, errorNode, summaryNode) {
  errorNode.textContent = ''
  let result
  try {
    result = await window.settings.validatePluginConfig(textarea.value)
  } catch (error) {
    errorNode.textContent = messageOf(error)
    return
  }
  if (!result.ok) {
    errorNode.textContent = result.message
    return
  }
  summaryNode.textContent = textarea.value.trim() === '' ? 'Config' : 'Config (set)'
}

/**
 * Fill the preset picker from the catalog main sent, disabling the presets
 * already configured and those that cannot be added yet.
 *
 * An unavailable preset stays visible rather than hidden: a user looking for
 * Linear should learn it is known and unsupported, not wonder whether they
 * typed the name wrong.
 */
function renderPresetPicker() {
  fillPresetPicker(
    { picker: 'mcp-preset', note: 'mcp-preset-note', add: 'add-mcp-preset' },
    new Set(mcpServers.map((server) => server.name)),
    saveInFlight,
  )
}

/**
 * Fill one preset picker and set its note and Add button to match.
 *
 * Shared by the global list and the per-project one: the catalog and the
 * rules for what can be added are the same in both places, only the servers
 * already present differ.
 * @param {{picker: string, note: string, add: string}} ids - the three element ids for this scope.
 * @param {Set<string>} taken - names already configured in this scope.
 * @param {boolean} busy - whether a write is in flight for this scope.
 */
function fillPresetPicker(ids, taken, busy) {
  const picker = el(ids.picker)
  // Rebuilding the options resets the selection to the first one, and this
  // runs on the picker's own change event — so without restoring it, choosing
  // a preset silently reverted to whichever is listed first and Add wrote
  // that one instead. Captured before the rebuild, reapplied after.
  const chosen = picker.value
  picker.textContent = ''
  for (const preset of mcpPresets) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.unavailable
      ? `${preset.label} — ${preset.unavailable}`
      : taken.has(preset.id)
        ? `${preset.label} — already added`
        : preset.label
    option.disabled = Boolean(preset.unavailable) || taken.has(preset.id)
    picker.append(option)
  }
  if (mcpPresets.some((preset) => preset.id === chosen)) picker.value = chosen
  // Derived from the catalog rather than read back off the <select>, so the
  // note and the Add button agree with the same source the options were
  // built from.
  const selected = mcpPresets.find((preset) => preset.id === picker.value)
  el(ids.note).textContent =
    selected === undefined || selected.unavailable === undefined
      ? 'Presets that need a browser sign-in are listed but cannot be added yet.'
      : `${selected.label} ${selected.unavailable}.`
  el(ids.add).disabled =
    busy || selected === undefined || selected.unavailable !== undefined || taken.has(selected.id)
}

/**
 * Warn when servers are configured but the master switch is off — the state
 * in which everything on this tab looks set up and nothing is connected.
 */
function renderMcpOffWarning() {
  el('mcp-off-warning').hidden = el('mcp-enabled').checked || mcpServers.length === 0
}

/**
 * A one-line description of what a server runs or reaches, for its row.
 * @param {{ transport: string, command?: string, args?: string[], url?: string }} server - the entry.
 * @returns {string} the summary.
 */
function mcpSummary(server) {
  if (server.transport !== 'stdio') return server.url ?? ''
  return [server.command, ...(server.args ?? [])].join(' ')
}

/**
 * Fill the project picker, keeping the current choice.
 *
 * The selection is captured and restored because rebuilding the options
 * clears `value`: a picker that reset itself on every refresh would move the
 * user to a different project mid-read.
 */
function renderWorkspacePicker() {
  const picker = el('mcp-workspace')
  const chosen = picker.value
  picker.textContent = ''
  for (const workspace of workspaces) {
    const option = document.createElement('option')
    option.value = workspace.path
    option.textContent = workspace.title
    picker.append(option)
  }
  if (workspaces.some((workspace) => workspace.path === chosen)) picker.value = chosen
  // Most recently used first, so the default is the project the user is most
  // likely working in — the harness records no current workspace.
  else if (workspaces.length > 0) picker.value = workspaces[0].path
  picker.disabled = workspaces.length === 0
}

/** The project currently chosen in the picker, or undefined when there are none. */
function chosenWorkspace() {
  return workspaces.find((workspace) => workspace.path === el('mcp-workspace').value)
}

/**
 * Render what the chosen project declares, with the same controls the global
 * list has: each row can be switched off or removed, and the section above
 * adds new ones.
 */
function renderWorkspaceRows() {
  const list = el('mcp-workspace-rows')
  const status = el('mcp-workspace-status')
  list.textContent = ''
  const workspace = chosenWorkspace()

  // Which file this card is about belongs in its header, beside the button
  // that opens it — not printed under the last row, where a bare path reads
  // as output from something rather than as an answer.
  const file = el('mcp-project-file')
  // Truncation from the left is a right-to-left container, which reorders the
  // path's leading slash to the visual end unless the run is marked
  // left-to-right. U+200E does that and renders as nothing.
  file.textContent = workspace === undefined ? '' : `\u200e${workspace.file}`
  file.title = workspace === undefined ? '' : workspace.file
  file.hidden = workspace === undefined

  if (workspace === undefined) {
    status.textContent = 'No projects yet. Open a folder in the harness and it will appear here.'
    el('open-project-mcp-file').disabled = true
    return
  }
  el('open-project-mcp-file').disabled = false

  if (workspace.servers.length === 0) {
    status.textContent = 'This project declares no servers yet.'
    return
  }
  status.textContent = ''

  for (const server of workspace.servers) {
    const row = document.createElement('li')
    row.className = 'plugin-row'

    const top = document.createElement('div')
    top.className = 'plugin-row-top'

    const main = document.createElement('div')
    main.className = 'plugin-row-main'

    const name = document.createElement('span')
    name.className = 'plugin-name'
    name.textContent = server.name
    main.append(name)

    const meta = document.createElement('span')
    meta.className = 'plugin-meta'
    meta.textContent = mcpSummary(server)
    main.append(meta)

    top.append(main)

    const actions = document.createElement('div')
    actions.className = 'plugin-row-actions'

    const toggle = document.createElement('label')
    toggle.className = 'mcp-row-toggle'
    const toggleBox = document.createElement('input')
    toggleBox.className = 'mcp-row-enabled'
    toggleBox.type = 'checkbox'
    toggleBox.checked = !server.disabled
    toggleBox.disabled = projectWriting
    toggleBox.setAttribute('aria-label', `Use ${server.name} in ${workspace.title}`)
    toggleBox.addEventListener('change', () => {
      void commitProjectServers(
        workspace.servers.map((entry) => (entry.name === server.name ? { ...entry, disabled: !toggleBox.checked } : entry)),
      )
    })
    toggle.append(toggleBox)
    const toggleText = document.createElement('span')
    toggleText.textContent = 'On'
    toggle.append(toggleText)
    actions.append(toggle)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'mcp-remove'
    remove.setAttribute('aria-label', `Remove ${server.name} from ${workspace.title}`)
    remove.textContent = 'Remove'
    remove.disabled = projectWriting
    remove.addEventListener('click', () => {
      void commitProjectServers(workspace.servers.filter((entry) => entry.name !== server.name))
    })
    actions.append(remove)

    top.append(actions)
    row.append(top)
    list.append(row)
  }
}

/**
 * Show or clear the "writing" state for the per-project section.
 * @param {boolean} busy - whether a write is in flight.
 */
function projectBusy(busy) {
  projectWriting = busy
  for (const id of ['add-mcp-project-preset', 'add-mcp-project-custom', 'paste-mcp-project-block', 'mcp-workspace']) {
    el(id).disabled = busy
  }
  renderProjectPresetPicker()
}

/** Fill the per-project preset picker from the same catalog the global one uses. */
function renderProjectPresetPicker() {
  const workspace = chosenWorkspace()
  fillPresetPicker(
    { picker: 'mcp-project-preset', note: 'mcp-project-preset-note', add: 'add-mcp-project-preset' },
    new Set((workspace?.servers ?? []).map((server) => server.name)),
    projectWriting || workspace === undefined,
  )
}

/**
 * Write the chosen project's servers through main and adopt what it accepted.
 *
 * No harness restart, unlike the global list: the bridge re-reads each
 * project's file per session and picks a change up within about a second.
 * @param {object[]} next - the list to persist.
 * @returns {Promise<void>} resolves once the write settled.
 */
async function commitProjectServers(next) {
  const workspace = chosenWorkspace()
  if (workspace === undefined) return
  const error = el('error-mcp-project')
  error.textContent = ''
  const previous = workspace.servers
  workspace.servers = next
  workspace.declared = true
  renderWorkspaceRows()
  projectBusy(true)
  try {
    const result = await window.settings.saveProjectMcpServers(workspace.file, next)
    if (!result.ok) {
      // Roll back rather than leave the window showing a list that is not on
      // disk, exactly as the global list does.
      workspace.servers = previous
      error.textContent = result.message
    }
  } catch (failure) {
    workspace.servers = previous
    error.textContent = messageOf(failure)
  } finally {
    projectBusy(false)
    renderWorkspaceRows()
  }
}

/**
 * Probe a candidate server, then add it to the chosen project.
 *
 * Probed for the same reason the global list probes: an `npx` server whose
 * first run downloads its package would otherwise meet the harness's 60
 * second tool-listing bound cold.
 * @param {object} server - the entry to add.
 * @returns {Promise<void>} resolves once the write settled.
 */
async function addProjectServer(server) {
  const error = el('error-mcp-project')
  error.textContent = ''
  projectBusy(true)
  try {
    const probed = await prepareServer(server)
    if (!probed.ok) {
      error.textContent = probed.message
      return
    }
  } finally {
    projectBusy(false)
  }
  await commitProjectServers([...(chosenWorkspace()?.servers ?? []), server])
}

/** Add the per-project picker's selected preset to the chosen project. */
async function addProjectPresetServer() {
  const workspace = chosenWorkspace()
  const preset = mcpPresets.find((candidate) => candidate.id === el('mcp-project-preset').value)
  if (workspace === undefined || preset === undefined || preset.unavailable !== undefined) return
  if (workspace.servers.some((server) => server.name === preset.id)) return
  await addProjectServer(presetEntry(preset))
}

/** Add a hand-entered server to the chosen project. */
async function addProjectCustomServer() {
  const workspace = chosenWorkspace()
  if (workspace === undefined) return
  const read = readCustomServer('mcp-project-custom', new Set(workspace.servers.map((server) => server.name)))
  const error = el('error-mcp-project-custom')
  error.textContent = read.error ?? ''
  if (read.server === undefined) return
  await addProjectServer(read.server)
  clearCustomFields('mcp-project-custom')
}

/**
 * Add every server a pasted block names to the chosen project's file.
 *
 * The whole block goes to main rather than being parsed here, for the same
 * reason the global paste does: main owns the grammar it re-validates.
 * @returns {Promise<void>} resolves once the paste settled.
 */
async function pasteProjectMcpBlock() {
  const workspace = chosenWorkspace()
  const error = el('error-mcp-project-paste')
  const textarea = el('mcp-project-paste')
  error.textContent = ''
  if (workspace === undefined) return
  if (textarea.value.trim() === '') {
    error.textContent = 'Paste the mcpServers block from a server\'s README.'
    return
  }
  projectBusy(true)
  try {
    const result = await window.settings.pasteProjectMcpBlock(workspace.file, textarea.value)
    if (!result.ok) {
      error.textContent = result.message
      return
    }
    workspace.servers = result.servers
    workspace.declared = true
    textarea.value = ''
  } catch (failure) {
    error.textContent = messageOf(failure)
  } finally {
    projectBusy(false)
    renderWorkspaceRows()
  }
}

/** Re-read the projects and their servers, and render both. */
async function loadWorkspaces() {
  workspaces = await window.settings.readWorkspaces()
  renderWorkspacePicker()
  renderWorkspaceRows()
  renderProjectPresetPicker()
}

/**
 * Open the chosen project's `mcp.json` in the OS-associated editor.
 *
 * Main refuses any path that is not a known project's, so the file this asks
 * for is only ever one the picker offered.
 */
async function openProjectMcpFile() {
  const workspace = chosenWorkspace()
  if (workspace === undefined) return
  const button = el('open-project-mcp-file')
  const result = el('open-project-mcp-file-result')
  button.disabled = true
  result.classList.remove('check-result-ok', 'check-result-failed')
  result.textContent = 'Opening…'
  try {
    const outcome = await window.settings.openProjectMcpFile(workspace.file)
    if (outcome.ok) {
      result.textContent = 'Opened.'
      result.classList.add('check-result-ok')
    } else {
      result.textContent = outcome.error
      result.classList.add('check-result-failed')
    }
  } catch (error) {
    result.textContent = messageOf(error)
    result.classList.add('check-result-failed')
  } finally {
    button.disabled = false
  }
}

/**
 * Render one row per configured server: what it runs or reaches, whether it
 * is on, and how to remove it.
 *
 * Reuses the plugin list's own row classes so the two lists read as one kind
 * of thing, which they are: both are rows the user adds, toggles, and removes.
 */
function renderMcpRows() {
  const list = el('mcp-rows')
  list.textContent = ''
  if (mcpServers.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hint'
    empty.textContent = 'No servers yet. Add one above, or paste a block from any server\'s README.'
    list.append(empty)
    return
  }

  for (const server of mcpServers) {
    const row = document.createElement('li')
    row.className = 'plugin-row'

    const top = document.createElement('div')
    top.className = 'plugin-row-top'

    const main = document.createElement('div')
    main.className = 'plugin-row-main'

    const name = document.createElement('span')
    name.className = 'plugin-name'
    name.textContent = server.name
    main.append(name)

    const meta = document.createElement('span')
    meta.className = 'plugin-meta'
    meta.textContent = mcpSummary(server)
    main.append(meta)

    top.append(main)

    const actions = document.createElement('div')
    actions.className = 'plugin-row-actions'

    const toggle = document.createElement('label')
    toggle.className = 'mcp-row-toggle'
    const toggleBox = document.createElement('input')
    toggleBox.className = 'mcp-row-enabled'
    toggleBox.type = 'checkbox'
    toggleBox.checked = !server.disabled
    toggleBox.disabled = saveInFlight
    toggleBox.setAttribute('aria-label', `Use ${server.name}`)
    toggleBox.addEventListener('change', () => {
      void commitMcpServers(mcpServers.map((entry) => (entry.name === server.name ? { ...entry, disabled: !toggleBox.checked } : entry)))
    })
    toggle.append(toggleBox)
    const toggleText = document.createElement('span')
    toggleText.textContent = 'On'
    toggle.append(toggleText)
    actions.append(toggle)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'mcp-remove'
    remove.setAttribute('aria-label', `Remove ${server.name}`)
    remove.textContent = 'Remove'
    remove.disabled = saveInFlight
    remove.addEventListener('click', () => {
      void commitMcpServers(mcpServers.filter((entry) => entry.name !== server.name))
    })
    actions.append(remove)

    top.append(actions)
    row.append(top)
    list.append(row)
  }
}

/**
 * Start a candidate stdio server before it is written, and report what it
 * offers.
 *
 * The harness gives a server 60 seconds to list its tools and does not expose
 * that bound, so an `npx` server whose first run downloads its package can
 * mount with no tools and no error. Doing the download here — with the
 * server's own output on screen — means the harness always meets a warm
 * cache. A remote server skips this: there is nothing to download and nothing
 * local to launch.
 * @param {object} server - the candidate entry.
 * @returns {Promise<{ ok: boolean, tools?: string[], message?: string }>} what it offers, or why not.
 */
async function prepareServer(server) {
  if (server.transport !== 'stdio') return { ok: true, tools: [] }
  const progress = el('mcp-progress')
  progress.textContent = ''
  progress.hidden = false
  el('mcp-status').textContent = `Starting ${server.name}… first run may download it, which can take a while.`
  try {
    return await window.settings.prepareMcpServer(server)
  } catch (failure) {
    return { ok: false, message: messageOf(failure) }
  } finally {
    progress.hidden = progress.textContent === ''
  }
}

/**
 * Add a server, having first proved it starts.
 *
 * A failed probe does not write: a server that cannot start would otherwise
 * sit in the list looking configured while contributing nothing. "Add anyway"
 * exists because a probe can be wrong — a server needing credentials this
 * window has not collected yet will refuse to start and still be worth
 * saving — so the refusal is a default, never a wall.
 * @param {object} server - the entry to add.
 * @returns {Promise<void>} resolves once the add settled.
 */
async function addServer(server) {
  const error = el('error-mcp')
  error.textContent = ''
  pendingServer = undefined
  el('mcp-add-anyway').hidden = true
  mcpBusy(true)
  try {
    const probed = await prepareServer(server)
    if (!probed.ok) {
      error.textContent = probed.message
      markTabError('mcp', true)
      pendingServer = server
      el('mcp-add-anyway').hidden = false
      return
    }
    if (probed.tools.length > 0) {
      el('mcp-status').textContent = `${server.name} is ready — ${String(probed.tools.length)} tools.`
    }
  } finally {
    mcpBusy(false)
  }
  enableMcpForFirstServer()
  await commitMcpServers([...mcpServers, server])
}

/**
 * Write a server list through main and adopt whatever it accepted.
 *
 * Servers are persisted immediately rather than on the window's Save button:
 * they live in `mcp.json`, which `save` does not write, so a change here
 * would otherwise sit in the window with no way to reach disk. Each write
 * restarts the harness, which is why the row controls disable while it runs.
 * @param {object[]} next - the list to persist.
 * @returns {Promise<void>} resolves once the write settled.
 */
async function commitMcpServers(next) {
  const error = el('error-mcp')
  error.textContent = ''
  markTabError('mcp', false)
  const previous = mcpServers
  mcpServers = next
  renderPresetPicker()
  renderMcpRows()
  renderMcpOffWarning()
  // The write itself is instant, but it does not resolve until the harness
  // has respawned with the new servers — measured at around 17 seconds.
  // Without this the tab sits on its previous rows behind disabled controls
  // for that whole time, which reads as nothing having happened.
  mcpBusy(true)
  el('mcp-status').textContent = 'Saving, and restarting the agent so it takes effect…'
  try {
    const result = await window.settings.saveMcpServers(next)
    if (!result.ok) {
      // Roll back rather than leave the window showing a list that is not on
      // disk: the next render would otherwise claim a server exists that the
      // harness never received.
      mcpServers = previous
      error.textContent = result.message
      markTabError('mcp', true)
    }
  } catch (failure) {
    mcpServers = previous
    error.textContent = messageOf(failure)
    markTabError('mcp', true)
  } finally {
    mcpBusy(false)
    renderPresetPicker()
    renderMcpRows()
    renderMcpOffWarning()
  }
}

/**
 * Show or clear the "restarting" state for the whole MCP tab.
 * @param {boolean} busy - whether a write is in flight.
 */
function mcpBusy(busy) {
  if (!busy) el('mcp-status').textContent = ''
  for (const id of ['add-mcp-preset', 'add-mcp-custom', 'paste-mcp-block']) el(id).disabled = busy
}

/**
 * Turn the master switch on when the first server is added.
 *
 * Adding a server is an unambiguous statement of intent, and leaving the
 * feature off after one would produce the dead end this exists to prevent: a
 * configured server and nothing connected. Only the first add flips it, so a
 * user who deliberately switched it off is not overridden by their next add.
 */
function enableMcpForFirstServer() {
  if (mcpServers.length === 0) el('mcp-enabled').checked = true
}

/**
 * Add the picker's selected preset as a new server.
 *
 * The preset's command or URL is copied onto the entry rather than
 * referenced, so a server keeps working as configured even if the catalog
 * later changes that vendor's endpoint.
 * @returns {Promise<void>} resolves once the write settled.
 */
async function addPresetServer() {
  const preset = mcpPresets.find((candidate) => candidate.id === el('mcp-preset').value)
  if (preset === undefined || preset.unavailable !== undefined) return
  if (mcpServers.some((server) => server.name === preset.id)) return
  await addServer(presetEntry(preset))
}

/**
 * Build the entry a preset describes.
 *
 * The preset's command or URL is copied onto the entry rather than
 * referenced, so a server keeps working as configured even if the catalog
 * later changes that vendor's endpoint.
 * @param {object} preset - the catalog entry.
 * @returns {object} the server entry to persist.
 */
function presetEntry(preset) {
  return {
    name: preset.id,
    disabled: false,
    transport: preset.transport,
    ...(preset.command === undefined ? {} : { command: preset.command }),
    args: preset.args ?? [],
    env: preset.env ?? {},
    ...(preset.url === undefined ? {} : { url: preset.url }),
    headers: {},
    rest: {},
  }
}

/**
 * Add a hand-entered server.
 *
 * Validated here only well enough to keep an obviously broken row out of the
 * list; main re-checks over the same rules, which is also what a hand-edited
 * `mcp.json` passes through.
 * @returns {Promise<void>} resolves once the write settled.
 */
async function addCustomServer() {
  const read = readCustomServer('mcp-custom', new Set(mcpServers.map((server) => server.name)))
  const error = el('error-mcp-custom')
  error.textContent = read.error ?? ''
  if (read.server === undefined) return
  await addServer(read.server)
  clearCustomFields('mcp-custom')
}

/**
 * Read one scope's hand-entry fields into a server entry.
 *
 * Validated here only well enough to keep an obviously broken row out of the
 * list; main re-checks over the same rules, which is also what a hand-edited
 * `mcp.json` passes through.
 * @param {string} prefix - the field id prefix for this scope.
 * @param {Set<string>} taken - names already configured in this scope.
 * @returns {{server?: object, error?: string}} the entry, or why it was refused.
 */
function readCustomServer(prefix, taken) {
  const name = el(`${prefix}-name`).value.trim()
  const command = el(`${prefix}-command`).value.trim()
  const url = el(`${prefix}-url`).value.trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    return { error: 'Use letters, digits, - and _ for the name, up to 32 characters.' }
  }
  if (taken.has(name)) return { error: `A server named ${name} is already in the list.` }
  if (command === '' && url === '') return { error: 'Give either a command to run, or an https:// URL.' }
  if (command === '' && !url.startsWith('https://')) return { error: 'The URL must start with https://.' }
  const args = el(`${prefix}-args`).value.trim()
  return {
    server: {
      name,
      disabled: false,
      transport: command === '' ? 'http' : 'stdio',
      ...(command === '' ? {} : { command }),
      args: args === '' ? [] : args.split(/\s+/),
      env: {},
      ...(command === '' ? { url } : {}),
      headers: {},
      rest: {},
    },
  }
}

/**
 * Empty one scope's hand-entry fields after a successful add.
 * @param {string} prefix - the field id prefix for this scope.
 */
function clearCustomFields(prefix) {
  for (const suffix of ['name', 'command', 'args', 'url']) el(`${prefix}-${suffix}`).value = ''
}

/**
 * Add every server a pasted `mcpServers` block names.
 *
 * The whole block goes to main rather than being parsed here: main owns the
 * grammar it will later re-validate, and a paste that main would reject must
 * not first appear in this window as though it had been accepted.
 * @returns {Promise<void>} resolves once the paste settled.
 */
async function pasteMcpBlock() {
  const error = el('error-mcp-paste')
  const textarea = el('mcp-paste')
  error.textContent = ''
  if (textarea.value.trim() === '') {
    error.textContent = 'Paste the mcpServers block from a server\'s README.'
    return
  }
  enableMcpForFirstServer()
  mcpBusy(true)
  try {
    const result = await window.settings.pasteMcpBlock(textarea.value)
    if (!result.ok) {
      error.textContent = result.message
      return
    }
    mcpServers = result.servers
    textarea.value = ''
  } catch (failure) {
    error.textContent = messageOf(failure)
  } finally {
    mcpBusy(false)
    renderPresetPicker()
    renderMcpRows()
    renderMcpOffWarning()
  }
}

/**
 * Render one row per entry in `pluginRows`, each showing the package, its
 * resolved version or that it is not installed yet, whether it is pinned,
 * and — inline, not in a separate list — any update offered for it. Each row
 * carries its own remove control and a collapsed-by-default config editor,
 * so a row with nothing configured stays as compact as before this field
 * existed and does not crowd out rows that do carry one.
 */
function renderPluginRows() {
  const list = el('plugin-rows')
  list.textContent = ''
  for (const plugin of pluginRows) {
    const row = document.createElement('li')
    row.className =
      plugin.disabledKind === 'needs-configuration'
        ? 'plugin-row plugin-row-needs-config'
        : plugin.disabledReason
          ? 'plugin-row plugin-row-disabled'
          : 'plugin-row'

    const top = document.createElement('div')
    top.className = 'plugin-row-top'

    const main = document.createElement('div')
    main.className = 'plugin-row-main'

    const name = document.createElement('span')
    name.className = 'plugin-name'
    name.textContent = plugin.package
    main.append(name)

    const meta = document.createElement('span')
    meta.className = 'plugin-meta'
    const state = plugin.version === undefined ? 'not installed yet' : `v${plugin.version} installed`
    meta.textContent = plugin.pinned ? `pinned, ${state}` : state
    main.append(meta)

    top.append(main)

    const actions = document.createElement('div')
    actions.className = 'plugin-row-actions'

    const latest = pluginUpdates.get(plugin.package)
    if (latest !== undefined) {
      const hint = document.createElement('span')
      hint.className = 'plugin-update-hint'
      hint.textContent = `${latest} available`
      actions.append(hint)

      const use = document.createElement('button')
      use.type = 'button'
      use.className = 'plugin-update-use'
      use.textContent = 'Use it'
      use.disabled = saveInFlight
      use.addEventListener('click', () => acceptPluginUpdate(plugin.package, latest))
      actions.append(use)
    }

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'plugin-remove'
    remove.setAttribute('aria-label', `Remove ${plugin.package}`)
    remove.textContent = 'Remove'
    remove.disabled = saveInFlight
    remove.addEventListener('click', () => removePlugin(plugin.package))
    actions.append(remove)

    top.append(actions)
    row.append(top)

    // Built before the disabled note below so a needs-configuration row can
    // link straight into its own editor rather than just naming the field
    // it needs. Collapsed to a one-line disclosure by default so a row with
    // nothing configured stays exactly as compact as before this field
    // existed; a row that has config set opens by default and relabels its
    // summary, so "something is configured here" is visible without
    // expanding every row in the list. A needs-configuration row does NOT
    // also auto-open this: several such rows opening at once on load would
    // read as a wall of forms rather than a calm list, and the note's own
    // "Open Config" control is one click away regardless of row count.
    const configWrap = document.createElement('details')
    configWrap.className = 'plugin-config'
    const hasConfig = (plugin.config ?? '').trim() !== ''
    configWrap.open = hasConfig

    const summary = document.createElement('summary')
    summary.textContent = hasConfig ? 'Config (set)' : 'Config'
    configWrap.append(summary)

    const textarea = document.createElement('textarea')
    textarea.className = 'plugin-config-input'
    textarea.rows = 3
    textarea.spellcheck = false
    textarea.setAttribute('aria-label', `${plugin.package} config, as JSON`)
    textarea.placeholder = '{ "key": "value" }'
    textarea.value = plugin.config ?? ''
    textarea.disabled = saveInFlight

    const configError = document.createElement('p')
    configError.className = 'error plugin-config-error'

    textarea.addEventListener('input', () => {
      plugin.config = textarea.value
    })
    textarea.addEventListener('blur', () => {
      void validatePluginConfigRow(textarea, configError, summary)
    })

    configWrap.append(textarea, configError)

    // A plugin the running harness dropped — either it never reached the
    // overlay (not installed, not loadable), a boot isolated it after
    // attributing a runtime failure to it, or cordis rejected its config —
    // carries the harness's own reason here, on its own row, rather than
    // only in the tray tooltip: this is where the user is already looking
    // to fix it. `disabledKind` (see `error-summary.ts`'s
    // `isConfigurationProblem`) splits this into two presentations: a
    // needs-configuration row reads as a setup step and points at the
    // Config editor above, a genuine failure keeps the loud, danger-toned
    // report. Both show the short extracted summary by default (see
    // `error-summary.ts`'s `summarizeFailure`), with the full,
    // often-thousands-of-characters raw text one click away in an expander.
    if (plugin.disabledKind === 'needs-configuration') {
      const note = document.createElement('p')
      note.className = 'plugin-needs-config-note'
      note.textContent = `Needs configuration: ${plugin.disabledSummary ?? plugin.disabledReason} `
      const action = document.createElement('button')
      action.type = 'button'
      action.className = 'plugin-needs-config-action'
      action.textContent = 'Open Config below'
      action.addEventListener('click', () => {
        configWrap.open = true
        textarea.focus()
      })
      note.append(action)
      row.append(note)

      const detail = document.createElement('details')
      detail.className = 'plugin-disabled-detail'

      const detailSummary = document.createElement('summary')
      detailSummary.textContent = 'Full error'
      detail.append(detailSummary)

      const pre = document.createElement('pre')
      pre.className = 'plugin-disabled-full'
      pre.textContent = plugin.disabledReason
      detail.append(pre)

      row.append(detail)
    } else if (plugin.disabledReason) {
      const note = document.createElement('p')
      note.className = 'plugin-disabled-note'
      note.textContent = `Disabled — the harness would not start with it: ${plugin.disabledSummary ?? plugin.disabledReason}`
      row.append(note)

      const detail = document.createElement('details')
      detail.className = 'plugin-disabled-detail'

      const detailSummary = document.createElement('summary')
      detailSummary.textContent = 'Full error'
      detail.append(detailSummary)

      const pre = document.createElement('pre')
      pre.className = 'plugin-disabled-full'
      pre.textContent = plugin.disabledReason
      detail.append(pre)

      row.append(detail)
    }

    // Mounted (tools work) but the browser half this plugin declares could
    // not be linked by name — the only way the harness discovers it — so
    // its UI silently would not appear without this note; see
    // `plugin-link.ts`'s `ensurePluginLink` and `runtime-files.ts`.
    if (plugin.clientWarning) {
      const note = document.createElement('p')
      note.className = 'plugin-client-warning-note'
      note.textContent = `Its UI will not load: ${plugin.clientWarning}`
      row.append(note)
    }

    row.append(configWrap)

    list.append(row)
  }
}

// Guards `addPlugin` against a second Add firing while the first's
// `validatePlugin` call is still in flight. Without it, two fast clicks on
// the same spec both read `pluginRows` before either has pushed a row, both
// pass the "not already in the list" check, and both append — a duplicate
// pair that then hits Save's own duplicate check (routed through
// `error-plugins`, since neither row is individually invalid).
let addingPlugin = false

/**
 * Validate the text in the Add input against the current rows and, if
 * accepted, append it as a new row and clear the input. Validation happens
 * here, in main over `settings.validatePlugin`, not deferred to Save.
 */
async function addPlugin() {
  if (addingPlugin || saveInFlight) return
  addingPlugin = true
  refreshAddDisabled()
  try {
    const input = el('plugin-spec')
    const errorNode = el('error-plugin-spec')
    errorNode.textContent = ''
    const spec = input.value
    const existingPackages = pluginRows.map((plugin) => plugin.package)
    let result
    try {
      result = await window.settings.validatePlugin(spec, existingPackages)
    } catch (error) {
      errorNode.textContent = messageOf(error)
      return
    }
    if (!result.ok) {
      errorNode.textContent = result.message
      return
    }
    pluginRows.push({ ...result.plugin, version: undefined, config: '' })
    input.value = ''
    renderPluginRows()
  } finally {
    addingPlugin = false
    refreshAddDisabled()
  }
}

/**
 * Remove exactly the row naming `pkg`, and any pending update offered for it.
 * A no-op while `saveInFlight`, matching the row's own Remove button, which
 * is rendered disabled for the same reason at the same time.
 * @param {string} pkg - the package name of the row to remove.
 */
function removePlugin(pkg) {
  if (saveInFlight) return
  pluginRows = pluginRows.filter((plugin) => plugin.package !== pkg)
  pluginUpdates.delete(pkg)
  renderPluginRows()
}

/**
 * Install `version` for `pkg`'s already-configured floating entry and store
 * it, without touching the entry's spec text — that is what keeps it
 * floating rather than silently pinning it the way rewriting the entry to
 * `pkg@version` would.
 *
 * Updates that one row's `version` in place rather than re-reading the whole
 * config: a full `load()` here would replace `pluginRows` wholesale,
 * silently discarding any row the user added or removed this session but has
 * not yet saved (a `load()` re-reads *disk*, which still has the old list).
 * This call only ever changes the one entry named by `pkg`, so it is the only
 * row that needs to change.
 *
 * The row is set to `result.version` — the concrete version main actually
 * resolved and wrote — never to the `version` argument: main's own
 * `resolveVersion` treats that argument as a spec to re-resolve, not a
 * final answer, so trusting it here would show the row something that might
 * not be what got installed. A no-op while `saveInFlight`, matching the
 * row's own "Use it" button, which is rendered disabled for the same reason
 * at the same time.
 * @param {string} pkg - the package name.
 * @param {string} version - the version to request installing.
 */
async function acceptPluginUpdate(pkg, version) {
  if (saveInFlight) return
  clearStatus()
  clearProgress()
  el('save').disabled = true
  try {
    const result = await window.settings.acceptPluginUpdate(pkg, version)
    const status = el('status')
    if (result.ok) {
      pluginUpdates.delete(pkg)
      const plugin = pluginRows.find((candidate) => candidate.package === pkg)
      if (plugin !== undefined) plugin.version = result.version
      status.textContent =
        result.warnings.length === 0 ? 'Settings saved.' : ['Settings saved.', ...result.warnings].join(' ')
      if (result.warnings.length > 0) status.classList.add('status-warning')
      renderPluginRows()
    } else {
      status.textContent = result.errors.kind ?? 'The update could not be applied.'
      status.classList.add('status-failed')
      renderPluginRows()
    }
  } catch (error) {
    const status = el('status')
    status.textContent = `The update could not be applied. ${messageOf(error)}`
    status.classList.add('status-failed')
    renderPluginRows()
  } finally {
    el('save').disabled = false
  }
}

/**
 * Show the success message for a save whose `warnings` are already known.
 * Pulled out so it can be applied both before and after the post-save
 * reload — see the comment at its second call in `performSave`.
 * @param {string[]} warnings - non-blocking problems the save reported.
 */
function showSavedStatus(warnings) {
  const status = el('status')
  status.textContent = warnings.length === 0 ? 'Settings saved.' : ['Settings saved.', ...warnings].join(' ')
  if (warnings.length > 0) status.classList.add('status-warning')
}

async function performSave() {
  clearErrors()
  clearStatus()
  clearProgress()
  hideUpdateHint()
  for (const tab of TABS) markTabError(tab, false)
  el('save').disabled = true
  // Add, Remove, and "Use it" are all refused for the duration (see
  // `saveInFlight`'s own comment) — that refusal is what makes the reload
  // below actually safe, rather than merely claimed to be: nothing local can
  // diverge from disk while this call is in flight.
  saveInFlight = true
  refreshAddDisabled()
  renderPluginRows()
  renderMcpRows()
  renderPresetPicker()
  try {
    const result = await window.settings.save(collect())
    if (result.ok) {
      showSavedStatus(result.warnings)
      // `save` reports only ok/warnings, never the resolved config — so the
      // only way the rows on screen learn the versions this save just
      // installed (turning "not installed yet" into "vX installed") is a
      // fresh read.
      await load()
      // `load()` touches `status` only on its own failure; a save that just
      // succeeded must keep saying so regardless, so the success message is
      // reasserted last rather than trusted to survive the reload untouched.
      showSavedStatus(result.warnings)
    } else {
      // Every rejected field's tab is marked with a dot, and the tab holding
      // the first one (in submission order) becomes active, so an error on a
      // field whose tab is not currently open is never left undiscoverable —
      // the whole reason this loop tracks tabs rather than only field names.
      // A key with no error node of its own (a future field that never grew
      // one, or `plugins`, whose accumulated-list errors have no single
      // field to attach to) still lands somewhere visible, on the status
      // line, rather than being silently dropped.
      const errorTabs = new Set()
      const unmapped = []
      let firstErrorTab
      for (const [name, message] of Object.entries(result.errors)) {
        if (name === 'kind') {
          // Not a field the user corrects — the source is a radio pair — and a
          // `kind` error rejects the whole save rather than naming a bad
          // value. It belongs beside the Save button that produced it, where
          // the success and failure messages already appear; under the radios
          // it would sit above the fold the user is looking at.
          const status = el('status')
          status.textContent = message
          status.classList.add('status-failed')
          continue
        }
        const target = el(`error-${name}`)
        if (target !== null) target.textContent = message
        else unmapped.push(message)
        const tab = FIELD_TAB[name]
        if (tab !== undefined) {
          errorTabs.add(tab)
          if (firstErrorTab === undefined) firstErrorTab = tab
        }
      }
      if (unmapped.length > 0) {
        const status = el('status')
        status.textContent = unmapped.join(' ')
        status.classList.add('status-failed')
      }
      for (const tab of errorTabs) markTabError(tab, true)
      if (firstErrorTab !== undefined && !errorTabs.has(activeTab)) selectTab(firstErrorTab, { focus: false })
    }
  } catch (error) {
    // A rejected invoke (the write itself failing with ENOSPC or EACCES, or
    // the main handler throwing) would otherwise be an unhandled rejection:
    // errors and status were just cleared and the button re-enables below, so
    // the user would see nothing at all and assume the save worked.
    const status = el('status')
    status.textContent = `Settings were not saved. ${messageOf(error)}`
    status.classList.add('status-failed')
  } finally {
    el('save').disabled = false
    // Re-enabled unconditionally, however the save ended — success, a
    // rejected field, or a thrown error — so a failed save never leaves Add,
    // Remove, and "Use it" stuck disabled.
    saveInFlight = false
    refreshAddDisabled()
    renderPluginRows()
    renderMcpRows()
    renderPresetPicker()
  }
}

/**
 * Render one binary's check outcome into its result node, beside the field it
 * describes.
 * @param {HTMLElement} node - the `.check-result` element for that binary.
 * @param {{ ok: boolean, version?: string, error?: string }} outcome - what
 *   `checkBinaries` reported for this one binary.
 */
function renderCheckResult(node, outcome) {
  node.classList.remove('check-result-ok', 'check-result-failed')
  if (outcome.ok) {
    node.textContent = `OK — ${outcome.version}`
    node.classList.add('check-result-ok')
  } else {
    node.textContent = outcome.error
    node.classList.add('check-result-failed')
  }
}

/**
 * Verify the pnpm/npm path fields as currently typed, exactly the way the
 * app would spawn them — never the saved config, and this never saves
 * anything itself. Bound by main's own timeout, so a hung binary cannot
 * leave the button stuck; this handler only awaits the one `invoke` call.
 */
async function checkBinaries() {
  const button = el('check-binaries')
  const pnpmResult = el('check-result-pnpm')
  const npmResult = el('check-result-npm')
  button.disabled = true
  pnpmResult.classList.remove('check-result-ok', 'check-result-failed')
  npmResult.classList.remove('check-result-ok', 'check-result-failed')
  pnpmResult.textContent = 'Checking…'
  npmResult.textContent = 'Checking…'
  try {
    const result = await window.settings.checkBinaries(el('pnpmPath').value, el('npmPath').value)
    renderCheckResult(pnpmResult, result.pnpm)
    renderCheckResult(npmResult, result.npm)
  } catch (error) {
    const message = messageOf(error)
    pnpmResult.textContent = message
    pnpmResult.classList.add('check-result-failed')
    npmResult.textContent = message
    npmResult.classList.add('check-result-failed')
  } finally {
    button.disabled = false
  }
}

/**
 * Open `mcp.json` in the OS-associated editor.
 *
 * The same contract as `openConfigFile`, for the other file this window
 * writes: main reports "nothing written yet" rather than creating one, and
 * the renderer never learns the path.
 */
async function openMcpConfigFile() {
  const button = el('open-mcp-config-file')
  const result = el('open-mcp-config-file-result')
  button.disabled = true
  result.classList.remove('check-result-ok', 'check-result-failed')
  result.textContent = 'Opening…'
  try {
    const outcome = await window.settings.openMcpConfigFile()
    if (outcome.ok) {
      result.textContent = 'Opened.'
      result.classList.add('check-result-ok')
    } else {
      result.textContent = outcome.error
      result.classList.add('check-result-failed')
    }
  } catch (error) {
    result.textContent = messageOf(error)
    result.classList.add('check-result-failed')
  } finally {
    button.disabled = false
  }
}

/**
 * Open `desktop.json` in the OS-associated editor.
 *
 * Never saves the form first: main reports "nothing written yet" rather than
 * this silently creating a file the user never asked to create. Success and
 * failure share `.check-result`'s styling with the Advanced tab's binary
 * checks, so both read as the same kind of one-shot feedback.
 */
async function openConfigFile() {
  const button = el('open-config-file')
  const result = el('open-config-file-result')
  button.disabled = true
  result.classList.remove('check-result-ok', 'check-result-failed')
  result.textContent = 'Opening…'
  try {
    const outcome = await window.settings.openConfigFile()
    if (outcome.ok) {
      result.textContent = 'Opened.'
      result.classList.add('check-result-ok')
    } else {
      result.textContent = outcome.error
      result.classList.add('check-result-failed')
    }
  } catch (error) {
    result.textContent = messageOf(error)
    result.classList.add('check-result-failed')
  } finally {
    button.disabled = false
  }
}

async function load() {
  let result
  try {
    result = await window.settings.read()
  } catch (error) {
    // Without this the form would sit at its markup defaults — every field
    // blank, the local radio checked — presenting itself as the stored
    // configuration when nothing was read at all. Saying so, and saying that
    // saving replaces rather than edits, keeps Save usable: this window is
    // where a broken configuration gets repaired.
    const status = el('status')
    status.textContent = `The current settings could not be read. ${messageOf(error)}`
    status.classList.add('status-failed')
    el('intro').textContent = 'Saving will replace the stored configuration with what you enter here.'
    return
  }
  el('intro').textContent = result.configured
    ? 'Changes are applied as soon as you save.'
    : 'Tell the app where to find the harness to get started.'
  const form = result.form
  for (const name of FIELDS) el(name).value = form[name]
  for (const radio of document.querySelectorAll('input[name="kind"]')) {
    radio.checked = radio.value === form.kind
  }
  showKind()
  pluginRows = result.plugins.map((plugin) => ({ ...plugin }))
  // A freshly loaded plugin's version may already reflect an update that was
  // pending; drop any hint whose package no longer has a stale version.
  for (const pkg of [...pluginUpdates.keys()]) {
    const plugin = pluginRows.find((candidate) => candidate.package === pkg)
    if (plugin === undefined || plugin.version === pluginUpdates.get(pkg)) pluginUpdates.delete(pkg)
  }
  renderPluginRows()

  el('mcp-enabled').checked = form.mcpEnabled
  el('view-tools').checked = form.viewTools
  // The servers come from mcp.json through their own channel, not from the
  // form: that file is the portable one, and `save` writes desktop.json.
  mcpServers = await window.settings.readMcpServers()
  mcpPresets = result.mcp.presets
  renderPresetPicker()
  renderMcpRows()
  renderMcpOffWarning()
  await loadWorkspaces()
}

for (const radio of document.querySelectorAll('input[name="kind"]')) {
  radio.addEventListener('change', showKind)
}

// WAI-ARIA "automatic activation" tabs: clicking or arrowing to a tab
// selects it immediately, matching what a native segmented control does.
// Home/End jump to the first/last tab; arrows wrap around.
for (const tab of TABS) {
  el(`tab-${tab}`).addEventListener('click', () => selectTab(tab))
  el(`tab-${tab}`).addEventListener('keydown', (event) => {
    const from = TABS.indexOf(tab)
    let target
    // The list runs down the window now, so Up/Down are the arrows that match
    // it; Left/Right keep working for anyone who learned them on the strip.
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = TABS[(from + 1) % TABS.length]
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') target = TABS[(from - 1 + TABS.length) % TABS.length]
    else if (event.key === 'Home') target = TABS[0]
    else if (event.key === 'End') target = TABS[TABS.length - 1]
    else return
    event.preventDefault()
    selectTab(target)
  })
}

el('browse').addEventListener('click', async () => {
  const picked = await window.settings.pickFolder()
  if (picked !== undefined) el('repo').value = picked
})

el('browse-workspace').addEventListener('click', async () => {
  const picked = await window.settings.pickFolder()
  if (picked !== undefined) el('workspace').value = picked
})

el('save').addEventListener('click', performSave)

el('use-latest').addEventListener('click', () => {
  el('version').value = el('latest-version').textContent
  void performSave()
})

el('add-plugin').addEventListener('click', () => {
  void addPlugin()
})

el('check-binaries').addEventListener('click', () => {
  void checkBinaries()
})

el('open-config-file').addEventListener('click', () => {
  void openConfigFile()
})

el('add-mcp-preset').addEventListener('click', () => void addPresetServer())
el('add-mcp-custom').addEventListener('click', () => void addCustomServer())
// Re-rendered on change so the note under the picker follows the selection:
// picking an OAuth-only preset has to explain itself before Add is pressed,
// not after.
el('mcp-preset').addEventListener('change', renderPresetPicker)
el('mcp-enabled').addEventListener('change', renderMcpOffWarning)
el('mcp-add-anyway').addEventListener('click', () => {
  if (pendingServer === undefined) return
  const server = pendingServer
  pendingServer = undefined
  el('mcp-add-anyway').hidden = true
  el('error-mcp').textContent = ''
  markTabError('mcp', false)
  enableMcpForFirstServer()
  void commitMcpServers([...mcpServers, server])
})
el('paste-mcp-block').addEventListener('click', () => void pasteMcpBlock())
el('open-mcp-config-file').addEventListener('click', () => {
  void openMcpConfigFile()
})
el('mcp-workspace').addEventListener('change', () => {
  renderWorkspaceRows()
  renderProjectPresetPicker()
})
el('mcp-project-preset').addEventListener('change', renderProjectPresetPicker)
el('add-mcp-project-preset').addEventListener('click', () => void addProjectPresetServer())
el('add-mcp-project-custom').addEventListener('click', () => void addProjectCustomServer())
el('paste-mcp-project-block').addEventListener('click', () => void pasteProjectMcpBlock())
el('open-project-mcp-file').addEventListener('click', () => {
  void openProjectMcpFile()
})

// Receive-only: the main process pushes progress lines while a managed
// install runs, and a later update-available result once the background
// registry lookup finishes. Neither adds a way to call into main.
window.settings.onProgress(appendProgress)
// A probed server's own output, shown while it starts. Separate from the npm
// progress node so a long download does not scroll a save's output away.
window.settings.onMcpProgress((line) => {
  const node = el('mcp-progress')
  node.hidden = false
  node.textContent = `${node.textContent}${line}\n`
  node.scrollTop = node.scrollHeight
})
window.settings.onUpdateAvailable((latest) => {
  if (latest === el('version').value) return
  el('latest-version').textContent = latest
  el('update-hint').hidden = false
})
window.settings.onPluginUpdateAvailable((pkg, latest) => {
  const plugin = pluginRows.find((candidate) => candidate.package === pkg)
  if (plugin === undefined || plugin.version === latest) return
  pluginUpdates.set(pkg, latest)
  renderPluginRows()
})

// The harness owns the light/dark choice and main resolves it; this window
// follows rather than reading the system, which would be light beside a dark
// harness. The attribute is what the vendored token sheets key on.
window.settings.onTheme((dark) => {
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
})
window.settings.askTheme()

void load()
