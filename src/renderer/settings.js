// Dumb form: reads values, sends them to main, renders whatever comes back.
// All validation lives in the main process.
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npxPath']
const el = (id) => document.getElementById(id)
const kindOf = () => document.querySelector('input[name="kind"]:checked').value

function showKind() {
  const npx = kindOf() === 'npx'
  el('local-fields').hidden = npx
  el('npx-fields').hidden = !npx
}

function clearErrors() {
  // Not every field has an error node: only the ones main can reject by name
  // do. The render loop below already tolerates an absent node, and this is
  // the same fact, so it is tolerated the same way rather than by requiring
  // the page to carry a node per field forever.
  for (const name of [...FIELDS, 'kind']) {
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

function collect() {
  const form = { kind: kindOf() }
  for (const name of FIELDS) form[name] = el(name).value
  return form
}

async function load() {
  const result = await window.settings.read()
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

el('save').addEventListener('click', async () => {
  clearErrors()
  clearStatus()
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
    status.textContent = `Settings were not saved. ${error && error.message ? error.message : String(error)}`
    status.classList.add('status-failed')
  } finally {
    el('save').disabled = false
  }
})

void load()
