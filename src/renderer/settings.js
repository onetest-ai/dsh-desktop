// Dumb form: reads values, sends them to main, renders whatever comes back.
// All validation lives in the main process.
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npmPath', 'plugins']
const el = (id) => document.getElementById(id)
const kindOf = () => document.querySelector('input[name="kind"]:checked').value

// The last plugins the main process reported, keyed by package name, so a
// later out-of-band update-available push can be rendered without another
// round trip. Reset on every `load`.
let pluginsByPackage = new Map()

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
  renderPluginUpdates()
}

function collect() {
  const form = { kind: kindOf() }
  for (const name of FIELDS) form[name] = el(name).value
  return form
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/** Render the plugin status block from `pluginsByPackage`, one line per entry. */
function renderPluginStatus() {
  const lines = [...pluginsByPackage.values()].map((plugin) => {
    const state = plugin.version === undefined ? 'not installed yet' : `v${plugin.version} installed`
    return `${plugin.package} — ${plugin.pinned ? 'pinned, ' : ''}${state}`
  })
  el('plugin-status').textContent = lines.join('\n')
}

/**
 * Render one hint row per pending update in `pluginUpdates`, each with its
 * own "Use it" button — never one shared element, so a second plugin's
 * update is never overwritten and left unreachable by the first's.
 */
function renderPluginUpdates() {
  const container = el('plugin-updates')
  container.textContent = ''
  for (const [pkg, latest] of pluginUpdates) {
    const row = document.createElement('p')
    row.className = 'hint update-hint'
    row.textContent = `${pkg}: version ${latest} is available. `
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Use it'
    button.addEventListener('click', () => acceptPluginUpdate(pkg, latest))
    row.append(button)
    container.append(row)
  }
}

/**
 * Install `version` for `pkg`'s already-configured floating entry and store
 * it, without touching the entry's spec text — that is what keeps it
 * floating rather than silently pinning it the way rewriting the textarea to
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
      renderPluginUpdates()
      status.textContent =
        result.warnings.length === 0 ? 'Settings saved.' : ['Settings saved.', ...result.warnings].join(' ')
      if (result.warnings.length > 0) status.classList.add('status-warning')
      await load()
    } else {
      status.textContent = result.errors.kind ?? 'The update could not be applied.'
      status.classList.add('status-failed')
    }
  } catch (error) {
    const status = el('status')
    status.textContent = `The update could not be applied. ${messageOf(error)}`
    status.classList.add('status-failed')
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
  pluginsByPackage = new Map(result.plugins.map((plugin) => [plugin.package, plugin]))
  renderPluginStatus()
  // A freshly loaded plugin's version may already reflect an update that was
  // pending; drop any hint whose package no longer has a stale version.
  for (const pkg of [...pluginUpdates.keys()]) {
    const plugin = pluginsByPackage.get(pkg)
    if (plugin === undefined || plugin.version === pluginUpdates.get(pkg)) pluginUpdates.delete(pkg)
  }
  renderPluginUpdates()
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
  const plugin = pluginsByPackage.get(pkg)
  if (plugin === undefined || plugin.version === latest) return
  pluginUpdates.set(pkg, latest)
  renderPluginUpdates()
})

void load()
