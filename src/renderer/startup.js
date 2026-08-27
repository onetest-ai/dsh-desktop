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

/** The mark a chip carries for each severity. */
const MARK = { ok: '✓', repairable: '↓', blocked: '!' }

/**
 * Render one chip per finding.
 *
 * A finding that is `ok` still renders: a screen that shows only problems
 * looks broken when nothing is wrong, and the row is what makes "checking"
 * legible rather than a spinner.
 * @param {{id: string, title: string, detail?: string, severity: string}[]} findings - what main checked.
 */
function renderFindings(findings) {
  const list = el('findings')
  list.textContent = ''
  for (const finding of findings) {
    const chip = document.createElement('li')
    chip.className = `finding finding-${finding.severity}`

    const title = document.createElement('span')
    title.className = 'finding-title'
    title.textContent = finding.title
    chip.append(title)

    const mark = document.createElement('span')
    mark.className = 'finding-mark'
    mark.textContent = MARK[finding.severity] ?? ''
    chip.append(mark)

    // The detail has no room of its own on a chip, so it becomes the tooltip;
    // a blocked finding's detail is also the phase line's job to explain.
    if (finding.detail !== undefined) chip.title = finding.detail
    list.append(chip)
  }
}

/**
 * Move the surface to a phase.
 * @param {string} phase - one of `checking`, `repairing`, `starting`, `failed`.
 */
function renderPhase(phase) {
  el('phase').textContent = PHASE_TEXT[phase] ?? ''
  el('startup-actions').hidden = phase !== 'failed'
}

window.startup.onFindings(renderFindings)
window.startup.onPhase(renderPhase)
window.startup.onProgress((line) => {
  const node = el('startup-progress')
  node.hidden = false
  // Only the newest line is kept: the overlay has room for a tail, not a
  // transcript, and during a wait the line that matters is the current one.
  node.textContent = line
})

el('open-settings').addEventListener('click', () => {
  window.startup.openSettings()
})
el('continue-anyway').addEventListener('click', () => {
  window.startup.continueAnyway()
})
