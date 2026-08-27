// Dumb surface: renders what main pushes and reports clicks back. Every
// decision — what is wrong, what can be repaired, whether to boot — is made
// in the main process; nothing here interprets a finding beyond its severity.
const el = (id) => document.getElementById(id)

/** What each phase says while it is current. */
const PHASE_TEXT = {
  checking: 'Checking your setup…',
  repairing: 'Installing what is missing. A first install can take a few minutes.',
  starting: 'Starting the harness…',
  failed: 'Some things need your attention before the harness can start.',
}

/**
 * Render one row per finding.
 *
 * A finding that is `ok` still renders: a screen that shows only problems
 * looks broken when nothing is wrong, and the list is what makes "checking"
 * legible rather than a spinner.
 * @param {{id: string, title: string, detail?: string, severity: string}[]} findings - what main checked.
 */
function renderFindings(findings) {
  const list = el('findings')
  list.textContent = ''
  for (const finding of findings) {
    const row = document.createElement('li')
    row.className = `finding finding-${finding.severity}`

    const title = document.createElement('span')
    title.className = 'finding-title'
    title.textContent = finding.title
    row.append(title)

    const state = document.createElement('span')
    state.className = 'finding-state'
    state.textContent =
      finding.severity === 'ok' ? 'ok' : finding.severity === 'repairable' ? 'installing…' : 'needs attention'
    row.append(state)

    if (finding.detail !== undefined && finding.severity !== 'ok') {
      const detail = document.createElement('p')
      detail.className = 'finding-detail'
      detail.textContent = finding.detail
      row.append(detail)
    }
    list.append(row)
  }
}

/**
 * Move the surface to a phase.
 * @param {string} phase - one of `checking`, `repairing`, `starting`, `failed`.
 */
function renderPhase(phase) {
  el('phase').textContent = PHASE_TEXT[phase] ?? ''
  // The progress node stays visible once revealed: install output is what the
  // user reads while a slow phase runs, and hiding it at the next phase would
  // take away the explanation for the wait they just had.
  if (phase === 'repairing') el('startup-progress').hidden = false
  el('startup-actions').hidden = phase !== 'failed'
}

window.startup.onFindings(renderFindings)
window.startup.onPhase(renderPhase)
window.startup.onProgress((line) => {
  const node = el('startup-progress')
  node.hidden = false
  node.textContent = `${node.textContent}${line}\n`
  node.scrollTop = node.scrollHeight
})

el('open-settings').addEventListener('click', () => {
  window.startup.openSettings()
})
el('continue-anyway').addEventListener('click', () => {
  window.startup.continueAnyway()
})
