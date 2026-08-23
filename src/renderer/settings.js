// Dumb form: reads values, sends them to main, renders whatever comes back.
// All validation lives in the main process.
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npmPath']
const el = (id) => document.getElementById(id)
const kindOf = () => document.querySelector('input[name="kind"]:checked').value

// The tab ids, in tab-bar order, and which panel each Save-rejectable key's
// error belongs to. `plugin-spec` is absent — it is validated on Add, not
// Save, and never appears in a save result — so an Add error never drives a
// tab switch; `plugins` names the accumulated-list error Save can still
// return (see `error-plugins` in the Plugins panel).
const TABS = ['harness', 'plugins', 'notifications', 'advanced']
const FIELD_TAB = {
  repo: 'harness',
  package: 'harness',
  version: 'harness',
  workspace: 'harness',
  notifyPort: 'notifications',
  hotkey: 'notifications',
  pnpmPath: 'advanced',
  npmPath: 'advanced',
  plugins: 'plugins',
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
    row.className = plugin.disabledReason ? 'plugin-row plugin-row-disabled' : 'plugin-row'

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

    // A plugin the running harness dropped — either it never reached the
    // overlay (not installed, not loadable) or a boot isolated it after
    // attributing a runtime failure to it — carries the harness's own reason
    // here, on its own row, rather than only in the tray tooltip: this is
    // where the user is already looking to fix it. The row shows the short
    // extracted summary by default (see `error-summary.ts`), with the full,
    // often-thousands-of-characters raw text one click away in an expander —
    // the same collapsed-by-default pattern the config editor below uses, so
    // a disabled row does not force a wall of stack trace on every glance at
    // the list.
    if (plugin.disabledReason) {
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
    if (event.key === 'ArrowRight') target = TABS[(from + 1) % TABS.length]
    else if (event.key === 'ArrowLeft') target = TABS[(from - 1 + TABS.length) % TABS.length]
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

// Receive-only: the main process pushes progress lines while a managed
// install runs, and a later update-available result once the background
// registry lookup finishes. Neither adds a way to call into main.
window.settings.onProgress(appendProgress)
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

void load()
