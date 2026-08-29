/**
 * Scripts run inside the page under automation.
 *
 * They are strings because they cross into another process through the
 * protocol's `Runtime.evaluate`; each is a single expression that returns a
 * plain value, since that is all the protocol can carry back.
 */

/**
 * How an element is named by a tool call.
 *
 * `ref=N` names a row of the last `browser_snapshot`, `text=...` matches
 * visible text, and anything else is a CSS selector.
 */
export type Target = string

/** The attribute a snapshot leaves on the elements it numbered. */
export const REF_ATTRIBUTE = 'data-dsh-ref'

/**
 * The expression that resolves a target to an element, for reuse inside other
 * scripts.
 * @param target - how the element is named.
 * @returns a JavaScript expression evaluating to the element or null.
 */
function resolve(target: Target): string {
  const literal = JSON.stringify(target)
  return `(() => {
    const target = ${literal}
    if (target.startsWith('ref=')) {
      return document.querySelector('[${REF_ATTRIBUTE}=' + JSON.stringify(target.slice(4)) + ']')
    }
    if (target.startsWith('text=')) {
      const wanted = target.slice(5).trim().toLowerCase()
      const candidates = document.querySelectorAll('button, a, input, select, textarea, label, [role], summary, li, td, th, span, div, h1, h2, h3, h4, h5, h6, p')
      let best = null
      for (const element of candidates) {
        const own = (element.textContent ?? '').trim().toLowerCase()
        const label = (element.getAttribute('aria-label') ?? element.value ?? '').toString().trim().toLowerCase()
        if (own !== wanted && label !== wanted) continue
        // The deepest match wins: an exact-text ancestor is a container that
        // happens to hold only the thing that was asked for.
        if (best === null || best.contains(element)) best = element
      }
      return best
    }
    try {
      return document.querySelector(target)
    } catch {
      return null
    }
  })()`
}

/**
 * Find an element and report the point to dispatch input at.
 *
 * Four things have to be true for a coordinate to be worth clicking, and each
 * has been observed failing on a real page:
 *
 * The element has to be scrolled to. `behavior: 'instant'` is explicit
 * because a page that sets `scroll-behavior: smooth` makes `scrollIntoView`
 * asynchronous, and the rectangle read straight afterwards is the one from
 * before the scroll.
 *
 * The point has to be inside the viewport. An element at the end of a short
 * page cannot be centred, so the point is taken from the part of it that is
 * actually on screen rather than from its middle.
 *
 * Something belonging to the element has to be on top at that point. An
 * advertisement over a button takes the click meant for the button, and the
 * page then reports nothing happening for a reason no amount of retrying
 * explains.
 *
 * And a covered centre is not a covered element. A banner across the middle
 * of a row leaves both ends clickable, so several points are tried before the
 * element is called unreachable.
 * @param target - how the element is named.
 * @param scroll - whether to scroll to it first. A drag reads its two ends in
 *   one scroll position, so the second read must not move the page under the
 *   first.
 * @returns the script's source; it returns the point and the element's
 *   identity, or a refusal saying which of these went wrong.
 */
export function locateScript(target: Target, scroll = true): string {
  return `(() => {
    const element = ${resolve(target)}
    if (element === null) return { found: false, reason: 'no element matches' }
    if (${String(scroll)}) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return { found: false, reason: 'the element has no size on screen' }
    const left = Math.max(rect.left, 0)
    const top = Math.max(rect.top, 0)
    const right = Math.min(rect.left + rect.width, window.innerWidth)
    const bottom = Math.min(rect.top + rect.height, window.innerHeight)
    if (right <= left || bottom <= top) {
      return { found: false, reason: 'the element is off screen even after scrolling to it' }
    }
    const identity = {
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute('type') ?? '').toLowerCase(),
      text: (element.textContent ?? '').trim().slice(0, 80),
    }
    const area = (box) => Math.max(box.width * box.height, 1)
    // A widget's own furniture: something sharing the element's immediate
    // parent, where that parent is no bigger than the widget itself — the
    // hidden input a combobox lays over its placeholder, which receives the
    // click on the widget's behalf. A page-level sibling is not that: under
    // <body> everything is a sibling, and an advertisement over a button is
    // exactly what this check exists to catch.
    const furniture = (hit) => {
      const parent = element.parentElement
      if (parent === null || parent === document.body || parent === document.documentElement) return false
      if (!parent.contains(hit)) return false
      return area(parent.getBoundingClientRect()) <= area(rect) * ${String(FURNITURE_SCALE)}
    }
    const across = (ratio) => left + (right - left) * ratio
    const down = (ratio) => top + (bottom - top) * ratio
    const points = [
      [across(0.5), down(0.5)],
      [across(0.25), down(0.5)],
      [across(0.75), down(0.5)],
      [across(0.5), down(0.25)],
      [across(0.5), down(0.75)],
    ]
    let covering = null
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y)
      if (hit === null) continue
      const mine = hit === element || element.contains(hit) || hit.contains(element) || furniture(hit)
      if (mine) return { found: true, x, y, ...identity }
      covering = covering ?? hit
    }
    if (covering === null) return { found: false, reason: 'nothing is at the points it occupies' }
    const name =
      covering.tagName.toLowerCase() +
      (covering.id === '' ? '' : '#' + covering.id) +
      (covering.className === '' || typeof covering.className !== 'string'
        ? ''
        : '.' + covering.className.trim().split(/\\s+/).join('.'))
    return { found: false, reason: 'covered by ' + name + '; scroll it away, close it, or resize the viewport' }
  })()`
}

/**
 * Put the caret in a field.
 *
 * Typing is dispatched as real key events, which land wherever focus is; this
 * is what puts focus in the right place.
 *
 * Nothing is cleared here. Emptying a field by assigning to it and announcing
 * the change is not what a person does, and a component can answer it however
 * it likes: a date picker given an empty value out of band unmounts itself
 * and takes the rest of the form with it. Clearing is done by selecting the
 * text and deleting it, through the same key events as the typing.
 * @param target - how the field is named.
 * @returns the script's source; it returns whether the field was focused.
 */
export function focusScript(target: Target): string {
  return `(() => {
    const element = ${resolve(target)}
    if (element === null) return { found: false, reason: 'no element matches' }
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    element.focus()
    const active = document.activeElement
    // Or the element that replaced it: a re-render swaps the node while
    // keeping its identity on the page, and focus follows the new one.
    const focused = active === element || (active !== null && element.id !== '' && active.id === element.id)
    return { found: true, focused }
  })()`
}

/**
 * Choose an option in a native `<select>`.
 *
 * By value or by the text the user reads, because a page's option values are
 * often opaque while its labels are what the task names. A custom combobox is
 * not a `<select>` and is driven by clicking instead.
 * @param target - how the select is named.
 * @param value - the option's value or its visible label.
 * @returns the script's source; it returns what was selected, or why it was not.
 */
export function selectOptionScript(target: Target, value: string): string {
  return `(() => {
    const element = ${resolve(target)}
    if (element === null) return { ok: false, reason: 'no element matches' }
    if (element.tagName.toLowerCase() !== 'select') {
      return { ok: false, reason: 'that is a ' + element.tagName.toLowerCase() + ', not a <select>; click it instead' }
    }
    const wanted = ${JSON.stringify(value)}
    const option = [...element.options].find((each) => each.value === wanted || each.text.trim() === wanted)
    if (option === undefined) {
      return { ok: false, reason: 'no such option; it has ' + JSON.stringify([...element.options].map((each) => each.text.trim())) }
    }
    element.value = option.value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, selected: option.text.trim() }
  })()`
}

/**
 * Number the page's interactive elements and describe them.
 *
 * The model picks what to act on from this rather than from a CSS selector it
 * guessed: a selector written against a page nobody has read is the single
 * largest source of automation that silently acts on the wrong thing. The
 * numbers are written onto the elements themselves, so a later call resolves
 * `ref=N` back to the same element even after the page re-renders around it.
 * @param limit - the most elements to number.
 * @returns the script's source; it returns one line per element.
 */
export function snapshotScript(limit: number): string {
  return `(() => {
    for (const stale of document.querySelectorAll('[${REF_ATTRIBUTE}]')) stale.removeAttribute('${REF_ATTRIBUTE}')
    const selector = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="option"], [contenteditable="true"], [onclick], [draggable="true"]'
    const lines = []
    let ref = 0
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect()
      // Nothing with no size: a hidden field or a collapsed menu is not
      // something the user could act on, and numbering it invites a click
      // that lands on whatever is actually there.
      if (rect.width === 0 || rect.height === 0) continue
      if (lines.length >= ${String(limit)}) { lines.push('… more elements not listed'); break }
      ref += 1
      element.setAttribute('${REF_ATTRIBUTE}', String(ref))
      const tag = element.tagName.toLowerCase()
      const role = element.getAttribute('role') ?? tag
      const name = (element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? (element.textContent ?? '').trim() ?? '').replace(/\\s+/g, ' ').slice(0, 60)
      const parts = ['ref=' + ref, role]
      if (name !== '') parts.push(JSON.stringify(name))
      if (element.id !== '') parts.push('#' + element.id)
      if ('value' in element && element.value !== '' && element.type !== 'password') parts.push('value=' + JSON.stringify(String(element.value).slice(0, 40)))
      if (element.checked === true) parts.push('checked')
      if (element.disabled === true) parts.push('disabled')
      lines.push(parts.join(' '))
    }
    return { url: location.href, title: document.title, elements: lines.join('\\n') }
  })()`
}

/**
 * How much larger than the element its parent may be for a sibling to still
 * count as part of the same widget.
 *
 * A combobox's control wrapper is barely larger than the placeholder inside
 * it; a page section holding a button and an advertisement is many times
 * larger. Wide enough for padding and a border, far short of a layout
 * container.
 */
const FURNITURE_SCALE = 4

/**
 * Whether a condition on the page holds yet.
 *
 * Text is matched against what the page renders rather than its markup, so a
 * value a framework has not painted yet does not read as present.
 * @param target - the element to wait for, or undefined when waiting on text.
 * @param text - the visible text to wait for, or undefined when waiting on an
 *   element.
 * @param gone - whether to wait for absence instead of presence.
 * @returns the script's source; it returns whether the wait is over.
 */
export function conditionScript(target: Target | undefined, text: string | undefined, gone: boolean): string {
  const found =
    target !== undefined
      ? `${resolve(target)} !== null`
      : `(document.body?.innerText ?? '').includes(${JSON.stringify(text ?? '')})`
  return `(() => {
    const present = ${found}
    return present !== ${String(gone)}
  })()`
}

/** The most elements one snapshot numbers; beyond this the model is reading noise. */
export const SNAPSHOT_LIMIT = 400
