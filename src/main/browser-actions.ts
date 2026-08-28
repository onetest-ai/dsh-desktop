import type { BrowserSession } from './browser-cdp'
import { keyEvent } from './browser-keys'
import {
  REF_ATTRIBUTE,
  SNAPSHOT_LIMIT,
  focusScript,
  locateScript,
  selectOptionScript,
  snapshotScript,
  type Target,
} from './browser-script'

/** What one action reports back. */
export type ActionResult = { ok: true; message: string } | { ok: false; reason: string }

/** Where an element is, as the page measured it. */
interface Located {
  found: boolean
  reason?: string
  x: number
  y: number
  tag: string
  type: string
  text: string
}

/**
 * How many moves a drag is broken into.
 *
 * A press and a release at two points is not a drag: jQuery UI and the HTML5
 * drag sources both start only after the pointer has moved, and they follow
 * it. This is the same interpolation a hand produces, at a resolution those
 * libraries settle at.
 */
const DRAG_STEPS = 12

/** The pause between drag moves, long enough for a frame to be laid out. */
const DRAG_FRAME_MS = 16

/** How long between the reads that decide whether an element has stopped moving. */
const SETTLE_STEP_MS = 100

/** How many times to re-read before giving up and dragging anyway. */
const SETTLE_READS = 10

/**
 * How many reads in a row must agree before a position is believed.
 *
 * One is not enough: late content arrives in bursts, and two reads taken
 * between two bursts agree with each other while the page is still moving.
 */
const SETTLE_AGREEMENTS = 2

/**
 * How long a page gets to start a native drag before the pointer path is
 * treated as an ordinary one.
 *
 * A page using the HTML5 drag API reports one almost immediately; a page
 * using plain mouse handlers never does, and waiting on it would add this to
 * every drag on such a page.
 */
const DRAG_INTERCEPT_MS = 300

/** The most characters one `browser_type` call sends. */
export const TYPE_LIMIT = 5_000

/**
 * Wait, so a page has a frame in which to react.
 * @param ms - how long to wait.
 * @returns resolution after that long.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Find an element, or say why it could not be acted on.
 * @param session - the protocol session.
 * @param target - how the element is named.
 * @returns where it is, or the refusal to return to the caller.
 */
async function locate(session: BrowserSession, target: Target, scroll = true): Promise<Located | ActionResult> {
  const found = await session.evaluate(locateScript(target, scroll))
  if (!found.ok) return found
  const at = found.value as Located
  if (!at.found) return { ok: false, reason: `${target}: ${at.reason ?? 'not found'}` }
  return at
}

/**
 * Whether a `locate` returned a refusal rather than a position.
 * @param value - what `locate` returned.
 * @returns true when it is a refusal.
 */
function refused(value: Located | ActionResult): value is ActionResult {
  return 'ok' in value
}

/**
 * The CSS selector for a target, for the protocol commands that take one.
 * @param target - how the element is named.
 * @returns the selector, or undefined when the target cannot be written as one.
 */
export function cssFor(target: Target): string | undefined {
  if (target.startsWith('ref=')) return `[${REF_ATTRIBUTE}="${target.slice(4)}"]`
  if (target.startsWith('text=')) return undefined
  return target
}

/**
 * Number the page's interactive elements and read them back.
 * @param session - the protocol session.
 * @returns the numbered elements, for a later call to act on by reference.
 */
export async function readPage(session: BrowserSession): Promise<ActionResult> {
  const out = await session.evaluate(snapshotScript(SNAPSHOT_LIMIT))
  if (!out.ok) return out
  const page = out.value as { url: string; title: string; elements: string }
  return { ok: true, message: `# ${page.title}\n${page.url}\n\n${page.elements}` }
}

/**
 * Click an element where it sits on screen.
 *
 * Dispatched through the protocol, so the page receives a trusted event: a
 * scripted `element.click()` is refused by file inputs, ignored by some
 * frameworks, and never opens a native dialog.
 * @param session - the protocol session.
 * @param target - how the element is named.
 * @param options - which button, and how many clicks.
 * @returns what was clicked, or why nothing was.
 */
export async function click(
  session: BrowserSession,
  target: Target,
  options: { button?: 'left' | 'right' | 'middle'; count?: number } = {},
): Promise<ActionResult> {
  const at = await locate(session, target)
  if (refused(at)) return at
  const button = options.button ?? 'left'
  const clickCount = options.count ?? 1
  const point = { x: at.x, y: at.y, button, clickCount, buttons: button === 'left' ? 1 : 2 }
  // Moved to first, because a menu or tooltip that only exists under the
  // pointer is not there to be clicked until the pointer arrives.
  await session.send('Input.dispatchMouseEvent', { ...point, type: 'mouseMoved', buttons: 0, clickCount: 0 })
  await session.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' })
  await session.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' })
  return { ok: true, message: `Clicked ${at.tag}${at.text === '' ? '' : ` "${at.text}"`}.` }
}

/**
 * Move the pointer over an element without pressing anything.
 * @param session - the protocol session.
 * @param target - how the element is named.
 * @returns what is now hovered, or why nothing is.
 */
export async function hover(session: BrowserSession, target: Target): Promise<ActionResult> {
  const at = await locate(session, target)
  if (refused(at)) return at
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 })
  return { ok: true, message: `Hovering ${at.tag}${at.text === '' ? '' : ` "${at.text}"`}.` }
}

/**
 * Type into a field, one key at a time.
 *
 * Key by key rather than by setting the value: a date picker, an
 * autocomplete, and a masked field all react to keys and would see nothing
 * from an assignment.
 * @param session - the protocol session.
 * @param target - how the field is named.
 * @param text - what to type.
 * @param clear - whether to empty the field first.
 * @returns what was typed, or why it was not.
 */
export async function type(
  session: BrowserSession,
  target: Target,
  text: string,
  clear: boolean,
): Promise<ActionResult> {
  if (text.length > TYPE_LIMIT) return { ok: false, reason: `More than ${TYPE_LIMIT} characters at once.` }
  const focused = await session.evaluate(focusScript(target, clear))
  if (!focused.ok) return focused
  const state = focused.value as { found: boolean; focused?: boolean; reason?: string }
  if (!state.found) return { ok: false, reason: `${target}: ${state.reason ?? 'not found'}` }
  if (state.focused !== true) return { ok: false, reason: `${target} did not take focus; it may not be a field.` }
  for (const character of text) {
    const event = keyEvent(character)
    if (event === undefined) {
      // A character with no key of its own — an emoji, a CJK glyph — has no
      // key event to dispatch, so it is inserted as text instead.
      await session.send('Input.insertText', { text: character })
      continue
    }
    await session.send('Input.dispatchKeyEvent', { ...event, type: 'keyDown' })
    await session.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' })
  }
  return { ok: true, message: `Typed ${JSON.stringify(text)}.` }
}

/**
 * Press one key, wherever focus is.
 * @param session - the protocol session.
 * @param name - the key, optionally with modifiers, as `Control+a`.
 * @returns what was pressed, or why it was not.
 */
export async function press(session: BrowserSession, name: string): Promise<ActionResult> {
  const event = keyEvent(name)
  if (event === undefined) return { ok: false, reason: `${name} is not a key.` }
  // A key that inserts nothing is a raw press; one that inserts a character
  // has to be the kind of event that carries the character.
  await session.send('Input.dispatchKeyEvent', { ...event, type: event.text === undefined ? 'rawKeyDown' : 'keyDown' })
  await session.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' })
  return { ok: true, message: `Pressed ${name}.` }
}

/**
 * Scroll to an element and wait until it stops moving.
 *
 * A page loads adverts and fonts after it is otherwise ready, and each of
 * them moves everything below. An element measured while that is still
 * happening is measured at a position the page abandons a moment later, and
 * the press then lands on nothing — which is what a drag that silently does
 * nothing looks like from the outside.
 *
 * Reading until the position repeats rather than pausing for a fixed time: a
 * settled page costs one extra read, and an unsettled one is waited out only
 * as long as it keeps moving.
 * @param session - the protocol session.
 * @param target - how the element is named.
 * @returns where it came to rest, or the refusal to return to the caller.
 */
async function settle(session: BrowserSession, target: Target): Promise<Located | ActionResult> {
  let previous = await locate(session, target)
  if (refused(previous)) return previous
  let agreements = 0
  for (let read = 0; read < SETTLE_READS; read += 1) {
    await pause(SETTLE_STEP_MS)
    const now = await locate(session, target, false)
    if (refused(now)) return now
    agreements = Math.abs(now.x - previous.x) < 1 && Math.abs(now.y - previous.y) < 1 ? agreements + 1 : 0
    previous = now
    if (agreements >= SETTLE_AGREEMENTS) return now
  }
  // Still moving after all that: something on the page animates without
  // stopping, and dragging from its last known place beats refusing outright.
  return previous
}

/** What a page put on the clipboard when it started a native drag. */
type DragPayload = Record<string, unknown>

/**
 * Move the pointer once, and catch a native drag if the page starts one.
 *
 * Interception has to be switched on before the drag begins: once Chromium
 * owns the pointer there is no way to steer it, and the drag ends wherever
 * the browser thinks the mouse was left.
 * @param session - the protocol session.
 * @param at - where to move to.
 * @returns the drag's payload if the page started one, otherwise undefined.
 */
async function beginNativeDrag(
  session: BrowserSession,
  at: { x: number; y: number },
): Promise<DragPayload | undefined> {
  try {
    await session.send('Input.setInterceptDrags', { enabled: true })
  } catch {
    // An Electron build whose protocol predates drag interception: the plain
    // pointer path still drives everything that listens for mouse events.
    return undefined
  }
  const caught = session.next('Input.dragIntercepted', DRAG_INTERCEPT_MS)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: at.x,
    y: at.y,
    button: 'left',
    buttons: 1,
  })
  const event = await caught
  if (event === undefined) {
    await session.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
    return undefined
  }
  return event.data as DragPayload
}

/**
 * Carry an intercepted native drag across to the target and drop it.
 *
 * The path is sent as drag events rather than as pointer moves, because a
 * drop target decides where an item lands from the positions it is dragged
 * over — a single event at the destination reorders nothing.
 * @param session - the protocol session.
 * @param data - the payload the page put on the drag.
 * @param start - where the drag began.
 * @param end - where it was aimed.
 * @param to - how the drop target is named, for re-reading where it has moved to.
 * @returns what was dragged where.
 */
async function finishNativeDrag(
  session: BrowserSession,
  data: DragPayload,
  start: Located,
  end: Located,
  to: Target,
): Promise<ActionResult> {
  try {
    const settled = await locate(session, to, false)
    const drop = refused(settled) ? end : settled
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      const ratio = step / DRAG_STEPS
      const at = {
        x: start.x + (drop.x - start.x) * ratio,
        y: start.y + (drop.y - start.y) * ratio,
        data,
      }
      // Both at every point: a drop target registers itself on `dragenter`
      // and only then reads `dragover`, so a path that enters once at the
      // start crosses every element after it without any of them listening.
      await session.send('Input.dispatchDragEvent', { ...at, type: 'dragEnter' })
      await session.send('Input.dispatchDragEvent', { ...at, type: 'dragOver' })
      await pause(DRAG_FRAME_MS)
    }
    await session.send('Input.dispatchDragEvent', { type: 'drop', x: drop.x, y: drop.y, data })
    return { ok: true, message: `Dragged ${start.tag} onto ${end.tag}, as an HTML5 drag.` }
  } finally {
    // Left on, every later drag on this page would be caught and never
    // completed — including one the user starts with their own mouse.
    await session.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
  }
}

/**
 * Drag from one element to another.
 *
 * Both ends are read in one scroll position: scrolling to the drop target
 * after measuring the source moves the source, and the drag then starts from
 * a point that is no longer on it.
 * @param session - the protocol session.
 * @param from - how the element to drag is named.
 * @param to - how the element to drop on is named.
 * @returns what was dragged where, or why nothing was.
 */
export async function drag(session: BrowserSession, from: Target, to: Target): Promise<ActionResult> {
  const start = await settle(session, from)
  if (refused(start)) return start
  const end = await locate(session, to, false)
  if (refused(end)) {
    return {
      ok: false,
      reason: `${to} is not on screen with ${from}; both ends of a drag have to be visible at once. Scroll to them or widen the viewport first. (${
        end.ok ? '' : end.reason
      })`,
    }
  }
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, buttons: 0 })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: start.x,
    y: start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  // A frame between the press and the first move, and another before the
  // release: a sortable list binds its move handler on mousedown and decides
  // where to drop on the last move it saw, so a sequence sent without pauses
  // is intermittently missed altogether.
  await pause(DRAG_FRAME_MS)
  let intercepted: DragPayload | undefined
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const ratio = step / DRAG_STEPS
    const at = { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }
    // The first move is what makes a page using the HTML5 drag API begin a
    // native drag. Chromium then owns the pointer, and every mouse event
    // after it is swallowed — so the rest of the path has to be sent as drag
    // events instead.
    if (step === 1 && intercepted === undefined) {
      intercepted = await beginNativeDrag(session, at)
      if (intercepted !== undefined) return await finishNativeDrag(session, intercepted, start, end, to)
    }
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: at.x,
      y: at.y,
      button: 'left',
      buttons: 1,
    })
    await pause(DRAG_FRAME_MS)
  }
  // Where the target is now, not where it was: a page whose adverts finish
  // loading mid-drag moves everything under the pointer, and releasing at the
  // point measured beforehand then drops on whatever took its place.
  const settled = await locate(session, to, false)
  const drop = refused(settled) ? end : settled
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: drop.x,
    y: drop.y,
    button: 'left',
    buttons: 1,
  })
  await pause(DRAG_FRAME_MS)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: drop.x,
    y: drop.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  return { ok: true, message: `Dragged ${start.tag} onto ${end.tag}.` }
}

/**
 * Choose an option in a native `<select>`.
 * @param session - the protocol session.
 * @param target - how the select is named.
 * @param value - the option's value or its visible label.
 * @returns what was selected, or why nothing was.
 */
export async function selectOption(
  session: BrowserSession,
  target: Target,
  value: string,
): Promise<ActionResult> {
  const out = await session.evaluate(selectOptionScript(target, value))
  if (!out.ok) return out
  const result = out.value as { ok: boolean; reason?: string; selected?: string }
  return result.ok
    ? { ok: true, message: `Selected ${JSON.stringify(result.selected ?? value)}.` }
    : { ok: false, reason: `${target}: ${result.reason ?? 'could not be selected'}` }
}

/**
 * Put a file on a file input, without a file chooser.
 *
 * The chooser is an operating-system window this app cannot drive, so the
 * protocol sets the input's files directly — the same thing every browser
 * automation tool does with an upload.
 * @param session - the protocol session.
 * @param target - how the input is named; text matching cannot be used here.
 * @param paths - the absolute paths to attach, already checked by the caller.
 * @returns what was attached, or why nothing was.
 */
export async function uploadFile(
  session: BrowserSession,
  target: Target,
  paths: string[],
): Promise<ActionResult> {
  const selector = cssFor(target)
  if (selector === undefined) {
    return { ok: false, reason: 'A file input has to be named by CSS selector or by ref, not by text.' }
  }
  try {
    await session.send('DOM.enable')
    const document = await session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
    const found = await session.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector,
    })
    if (found.nodeId === 0) return { ok: false, reason: `${selector} matches nothing.` }
    await session.send('DOM.setFileInputFiles', { files: paths, nodeId: found.nodeId })
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true, message: `Attached ${paths.join(', ')}.` }
}

/**
 * Give the page a viewport of a chosen size.
 *
 * An override of what the page measures, not a resize of the window: the
 * browser column is as wide as the user left it, and a page whose layout
 * depends on width — a table that collapses, an advert that overlaps —
 * otherwise cannot be put into the state a task describes.
 * @param session - the protocol session.
 * @param width - the width in CSS pixels, or 0 to go back to the real one.
 * @param height - the height in CSS pixels.
 * @returns what the page now measures.
 */
export async function resizeViewport(
  session: BrowserSession,
  width: number,
  height: number,
): Promise<ActionResult> {
  try {
    if (width === 0 || height === 0) {
      await session.send('Emulation.clearDeviceMetricsOverride')
      return { ok: true, message: 'The page measures the browser column again.' }
    }
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true, message: `The page now measures ${width}×${height}.` }
}

/**
 * Capture the page as a PNG.
 * @param session - the protocol session.
 * @returns the image as base64, or why it could not be taken.
 */
export async function screenshot(session: BrowserSession): Promise<{ ok: true; png: string } | { ok: false; reason: string }> {
  try {
    const shot = await session.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
    return { ok: true, png: shot.data }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}
