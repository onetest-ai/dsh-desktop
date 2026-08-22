// Dumb form: reads values, sends them to main, renders whatever comes back.
// All validation lives in the main process.
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npmPath']
const el = (id) => document.getElementById(id)
const kindOf = () => document.querySelector('input[name="kind"]:checked').value

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
  for (const name of FIELDS) {
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

function hideUpdateHint() {
  el('update-hint').hidden = true
  pluginUpdates.clear()
  renderPluginRows()
}

function collect() {
  const form = { kind: kindOf() }
  for (const name of FIELDS) form[name] = el(name).value
  // The wire format `validateSettings` expects is still one spec per line —
  // only the way the user builds that list changed, from a free-text
  // textarea to rows validated one at a time on Add.
  form.plugins = pluginRows.map((plugin) => plugin.spec).join('\n')
  return form
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/**
 * Render one row per entry in `pluginRows`, each showing the package, its
 * resolved version or that it is not installed yet, whether it is pinned,
 * and — inline, not in a separate list — any update offered for it. Each row
 * carries its own remove control.
 */
function renderPluginRows() {
  const list = el('plugin-rows')
  list.textContent = ''
  for (const plugin of pluginRows) {
    const row = document.createElement('li')
    row.className = 'plugin-row'

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

    row.append(main)

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
      use.addEventListener('click', () => acceptPluginUpdate(plugin.package, latest))
      actions.append(use)
    }

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'plugin-remove'
    remove.setAttribute('aria-label', `Remove ${plugin.package}`)
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => removePlugin(plugin.package))
    actions.append(remove)

    row.append(actions)
    list.append(row)
  }
}

/**
 * Validate the text in the Add input against the current rows and, if
 * accepted, append it as a new row and clear the input. Validation happens
 * here, in main over `settings.validatePlugin`, not deferred to Save.
 */
async function addPlugin() {
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
  pluginRows.push({ ...result.plugin, version: undefined })
  input.value = ''
  renderPluginRows()
}

/**
 * Remove exactly the row naming `pkg`, and any pending update offered for it.
 * @param {string} pkg - the package name of the row to remove.
 */
function removePlugin(pkg) {
  pluginRows = pluginRows.filter((plugin) => plugin.package !== pkg)
  pluginUpdates.delete(pkg)
  renderPluginRows()
}

/**
 * Install `version` for `pkg`'s already-configured floating entry and store
 * it, without touching the entry's spec text — that is what keeps it
 * floating rather than silently pinning it the way rewriting the entry to
 * `pkg@version` would.
 * @param {string} pkg - the package name.
 * @param {string} version - the version to install and store.
 */
async function acceptPluginUpdate(pkg, version) {
  clearStatus()
  clearProgress()
  el('save').disabled = true
  try {
    const result = await window.settings.acceptPluginUpdate(pkg, version)
    const status = el('status')
    if (result.ok) {
      pluginUpdates.delete(pkg)
      status.textContent =
        result.warnings.length === 0 ? 'Settings saved.' : ['Settings saved.', ...result.warnings].join(' ')
      if (result.warnings.length > 0) status.classList.add('status-warning')
      await load()
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

async function performSave() {
  clearErrors()
  clearStatus()
  clearProgress()
  hideUpdateHint()
  el('save').disabled = true
  try {
    const result = await window.settings.save(collect())
    if (result.ok) {
      const status = el('status')
      if (result.warnings.length === 0) {
        status.textContent = 'Settings saved.'
      } else {
        status.textContent = ['Settings saved.', ...result.warnings].join(' ')
        status.classList.add('status-warning')
      }
    } else {
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
      }
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
