/**
 * Put a path into the harness's message box.
 *
 * The box is a React-controlled field, so assigning `value` is not enough:
 * React holds its own copy and would overwrite it on the next render. Writing
 * through the prototype's setter and then dispatching `input` is what makes
 * React see the change as one the user made — the standard way to drive a
 * controlled field from outside, and the only one available here, since this
 * plugin has no access to the state behind it.
 * @param text - what to append.
 * @param field - the field to write into; defaults to the page's own.
 * @returns whether a field was found to write into.
 */
export function appendToComposer(text: string, field = findComposer()): boolean {
  if (field === undefined) return false
  const setter = Object.getOwnPropertyDescriptor(
    field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  if (setter === undefined) return false
  const current = field.value
  // A space between what is there and what is added, unless the box is empty
  // or already ends in one.
  const separator = current === '' || current.endsWith(' ') ? '' : ' '
  setter.call(field, `${current}${separator}${text} `)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.focus()
  return true
}

/**
 * The message box on the page, if there is one.
 *
 * Found by role rather than by class: the harness's own class names are
 * generated and change between builds, while the composer is the page's one
 * visible multi-line text box.
 * @returns the field, or undefined when no session is open.
 */
export function findComposer(): HTMLTextAreaElement | HTMLInputElement | undefined {
  const boxes = [...document.querySelectorAll('textarea')].filter(
    (box) => !box.disabled && !box.readOnly && box.offsetParent !== null,
  )
  return boxes[boxes.length - 1]
}
