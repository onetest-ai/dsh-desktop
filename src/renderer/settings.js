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
  for (const name of [...FIELDS, 'kind']) el(`error-${name}`).textContent = ''
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
  el('save').disabled = true
  try {
    const result = await window.settings.save(collect())
    if (result.ok) {
      el('error-kind').textContent = result.warnings.join(' ')
    } else {
      for (const [name, message] of Object.entries(result.errors)) {
        const target = el(`error-${name}`)
        if (target !== null) target.textContent = message
      }
    }
  } finally {
    el('save').disabled = false
  }
})

void load()
