// Dumb form: reads values, sends them to main, renders whatever comes back.
// All validation lives in the main process.
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npmPath']
const el = (id) => document.getElementById(id)
const kindOf = () => document.querySelector('input[name="kind"]:checked').value

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
}

function collect() {
  const form = { kind: kindOf() }
  for (const name of FIELDS) form[name] = el(name).value
  return form
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
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

void load()
