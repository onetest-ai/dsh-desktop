// The dividers and the rail: this page is only ever visible in the gaps
// between the views. It reports drags to main, which owns the layout — the
// page has no way to know where the views are.

// The harness keys its tokens off this attribute, and main decides whether it
// applies — a page's own prefers-color-scheme answers for the document, not
// the machine. See vendor/dsh-theme.
window.shell.onTheme((dark) => {
  if (dark) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
})
window.shell.askTheme()
let dragging

/**
 * Report the pointer's window x for one column.
 *
 * Sent as a window coordinate rather than a delta: main knows the window's
 * own size, the other columns, and every minimum, so it can clamp against
 * them without this page tracking any of it.
 * @param {string} column - which column the divider belongs to.
 * @param {PointerEvent} event - the move that carried the pointer.
 */
function report(column, event) {
  window.shell.resizeColumn(column, Math.round(event.screenX - window.screenX))
}

// Main sends these on every layout pass. Without them both dividers would
// fill the page and the one drawn last would take every pointer event,
// including the other column's.
window.shell.onPlaces((places) => {
  for (const divider of document.querySelectorAll('.divider')) {
    const place = places[divider.dataset.column]
    divider.style.left = `${place.x}px`
    divider.style.width = `${place.width}px`
    // A closed column leaves a zero-width gap; hiding it as well keeps it out
    // of the tab order, where a separator that resizes nothing is noise.
    divider.hidden = place.width === 0
  }
  const rail = document.getElementById('rail')
  rail.style.left = `${places.rail.x}px`
  rail.style.width = `${places.rail.width}px`
  document.getElementById('rail-files').setAttribute('aria-pressed', String(places.open.files))
  document.getElementById('rail-web').setAttribute('aria-pressed', String(places.open.web))
})

document.getElementById('rail-files').addEventListener('click', () => {
  window.shell.toggleFiles()
})
document.getElementById('rail-web').addEventListener('click', () => {
  window.shell.toggleWeb()
})

for (const divider of document.querySelectorAll('.divider')) {
  const column = divider.dataset.column

  divider.addEventListener('pointerdown', (event) => {
    dragging = column
    divider.classList.add('dragging')
    divider.setPointerCapture(event.pointerId)
  })

  divider.addEventListener('pointermove', (event) => {
    if (dragging === column) report(column, event)
  })

  divider.addEventListener('pointerup', (event) => {
    if (dragging !== column) return
    dragging = undefined
    divider.classList.remove('dragging')
    divider.releasePointerCapture(event.pointerId)
    // Only the end of a drag is stored: writing on every move would put a file
    // write behind every pointer event.
    window.shell.commitColumns()
  })

  // A keyboard user gets the same range in steps, since a pointer drag on a
  // 6px strip is not an accessible way to size a column.
  divider.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? 20 : event.key === 'ArrowRight' ? -20 : 0
    if (step === 0) return
    event.preventDefault()
    window.shell.nudgeColumn(column, step)
    window.shell.commitColumns()
  })
}
