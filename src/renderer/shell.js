// The divider, and nothing else: this page is only ever visible in the gap
// between the two views. It reports drags to main, which owns the layout —
// the page has no way to know where the views are.
const divider = document.getElementById('divider')

let dragging = false

/**
 * Report the pointer's window x to main, which turns it into a pane width.
 *
 * Sent as a window coordinate rather than a delta: main knows the window's
 * own size and both minimums, so it can clamp against them without this page
 * tracking any of it.
 * @param {PointerEvent} event - the move that carried the pointer.
 */
function report(event) {
  window.shell.resizePane(Math.round(event.screenX - window.screenX))
}

divider.addEventListener('pointerdown', (event) => {
  dragging = true
  divider.classList.add('dragging')
  divider.setPointerCapture(event.pointerId)
})

divider.addEventListener('pointermove', (event) => {
  if (dragging) report(event)
})

divider.addEventListener('pointerup', (event) => {
  if (!dragging) return
  dragging = false
  divider.classList.remove('dragging')
  divider.releasePointerCapture(event.pointerId)
  // Only the end of a drag is stored: writing on every move would put a file
  // write behind every pointer event.
  window.shell.commitPane()
})

// A keyboard user gets the same range in steps, since a pointer drag on a
// 6px strip is not an accessible way to size a pane.
divider.addEventListener('keydown', (event) => {
  const step = event.key === 'ArrowLeft' ? 20 : event.key === 'ArrowRight' ? -20 : 0
  if (step === 0) return
  event.preventDefault()
  window.shell.nudgePane(step)
})
