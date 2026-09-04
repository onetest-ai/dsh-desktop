import { describe, expect, it } from 'vitest'
import type { BrowserSession, Evaluated } from './browser-cdp'
import {
  TYPE_LIMIT,
  click,
  cssFor,
  drag,
  dragCancel,
  dragDrop,
  dragMove,
  dragStart,
  hover,
  press,
  readPage,
  resizeViewport,
  screenshot,
  selectOption,
  type,
  uploadFile,
  waitFor,
} from './browser-actions'

/** One command the actions sent. */
interface Sent {
  method: string
  params?: Record<string, unknown>
}

/**
 * A session that records commands and answers evaluations from a queue.
 *
 * The last answer repeats once the queue runs out, so a test that cares about
 * one step does not have to enumerate every read the action makes.
 * @param answers - what each `evaluate` returns, in order.
 * @param replies - what each protocol command returns, by method.
 * @returns the stand-in session and the commands it received.
 */
function fakeSession(
  answers: Evaluated[] = [],
  replies: Record<string, unknown> = {},
  events: Record<string, Record<string, unknown> | undefined> = {},
): { session: BrowserSession; sent: Sent[] } {
  const sent: Sent[] = []
  const queue = [...answers]
  const session = {
    evaluate: async (expression: string) => {
      sent.push({ method: 'evaluate', params: { expression } })
      return (queue.length > 1 ? queue.shift() : queue[0]) ?? { ok: true, value: undefined }
    },
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params })
      const reply = replies[method]
      if (reply instanceof Error) throw reply
      return reply ?? {}
    },
    // No page starts a native drag unless a test says one does.
    next: async (method: string) => events[method],
  } as unknown as BrowserSession
  return { session, sent }
}

/**
 * A session that answers each `evaluate` by which element it asks about.
 *
 * Drag reads its two ends several times over — scrolling, settling,
 * re-reading where the target ended up — so a queue of answers in call order
 * would have to be re-counted every time that sequence changes.
 * @param byTarget - the answer for an expression naming each target.
 * @param replies - what each protocol command returns, by method.
 * @param events - what `next` resolves to, by event name.
 * @returns the stand-in session and the commands it received.
 */
function targetedSession(
  byTarget: Record<string, Evaluated>,
  replies: Record<string, unknown> = {},
  events: Record<string, Record<string, unknown> | undefined> = {},
): { session: BrowserSession; sent: Sent[] } {
  const sent: Sent[] = []
  const session = {
    evaluate: async (expression: string) => {
      sent.push({ method: 'evaluate', params: { expression } })
      const match = Object.keys(byTarget).find((target) => expression.includes(JSON.stringify(target)))
      if (match === undefined) throw new Error(`no answer for ${expression.slice(0, 60)}`)
      return byTarget[match]
    },
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params })
      const reply = replies[method]
      if (reply instanceof Error) throw reply
      return reply ?? {}
    },
    next: async (method: string) => events[method],
  } as unknown as BrowserSession
  return { session, sent }
}

/** An element the page reports as found, at a fixed point. */
const AT = { ok: true as const, value: { found: true, x: 30, y: 40, tag: 'button', type: '', text: 'Go' } }

/** A second element, somewhere else on the page. */
const ELSEWHERE = { ok: true as const, value: { found: true, x: 200, y: 300, tag: 'div', type: '', text: 'Drop' } }

/** What the page reports when nothing matches. */
const MISSING = { ok: true as const, value: { found: false, reason: 'no element matches' } }

describe('cssFor', () => {
  it('turns a reference into the attribute a snapshot wrote', () => {
    expect(cssFor('ref=7')).toBe('[data-dsh-ref="7"]')
  })

  it('passes a CSS selector through', () => {
    expect(cssFor('#submit')).toBe('#submit')
  })

  it('has no selector for a text match', () => {
    expect(cssFor('text=Submit')).toBeUndefined()
  })
})

describe('click', () => {
  // reason: a page whose adverts are still arriving moves its own controls by
  // more than the height of one, and a click at a point measured a moment
  // earlier lands on the button above the one that was asked for.
  it('waits for the element to stop moving before clicking it', async () => {
    const places = [100, 200, 300, 300, 300]
    let read = 0
    const session = {
      evaluate: async () => {
        const y = places[Math.min(read, places.length - 1)]
        read += 1
        return { ok: true as const, value: { found: true, x: 30, y, tag: 'button', type: '', text: 'Go' } }
      },
      send: async () => ({}),
      next: async () => undefined,
    } as unknown as BrowserSession
    const sent: number[] = []
    const original = session.send.bind(session)
    session.send = async (method: string, params?: Record<string, unknown>) => {
      if (params?.type === 'mousePressed') sent.push(params.y as number)
      return await original(method, params)
    }
    await click(session, '#go')
    expect(sent).toEqual([300])
  })

  it('presses and releases at the element, after moving there', async () => {
    const { session, sent } = fakeSession([AT])
    expect(await click(session, '#go')).toEqual({ ok: true, message: 'Clicked button "Go".' })
    const mouse = sent.filter((each) => each.method === 'Input.dispatchMouseEvent')
    expect(mouse.map((each) => each.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(mouse[1].params).toMatchObject({ x: 30, y: 40, button: 'left', clickCount: 1 })
  })

  it('clicks with another button and count when asked', async () => {
    const { session, sent } = fakeSession([AT])
    await click(session, '#go', { button: 'right', count: 2 })
    expect(sent.filter((each) => each.method === 'Input.dispatchMouseEvent')[1].params).toMatchObject({
      button: 'right',
      clickCount: 2,
    })
  })

  it('sends no input when the element is not there', async () => {
    const { session, sent } = fakeSession([MISSING])
    expect(await click(session, '#go')).toEqual({ ok: false, reason: '#go: no element matches' })
    expect(sent.filter((each) => each.method === 'Input.dispatchMouseEvent')).toEqual([])
  })

  it('passes on an error the page raised while locating', async () => {
    const { session } = fakeSession([{ ok: false, reason: 'target closed' }])
    expect(await click(session, '#go')).toEqual({ ok: false, reason: 'target closed' })
  })
})

describe('hover', () => {
  it('moves the pointer with no button held', async () => {
    const { session, sent } = fakeSession([AT])
    expect(await hover(session, '#go')).toMatchObject({ ok: true })
    expect(sent.filter((each) => each.method === 'Input.dispatchMouseEvent')[0].params).toEqual({
      type: 'mouseMoved',
      x: 30,
      y: 40,
      buttons: 0,
    })
  })
})

describe('type', () => {
  const focused = { ok: true as const, value: { found: true, focused: true } }

  it('sends a key down and up per character', async () => {
    const { session, sent } = fakeSession([focused])
    expect(await type(session, '#name', 'ab', false)).toEqual({ ok: true, message: 'Typed "ab".' })
    const keys = sent.filter((each) => each.method === 'Input.dispatchKeyEvent')
    expect(keys.map((each) => [each.params?.type, each.params?.key])).toEqual([
      ['keyDown', 'a'],
      ['keyUp', 'a'],
      ['keyDown', 'b'],
      ['keyUp', 'b'],
    ])
  })

  // reason: assigning an empty value and announcing it is not what a person
  // does — a date picker answers that by unmounting itself and the form
  // around it. Selecting and deleting is what a keyboard produces.
  it('clears by selecting the old value and typing over it', async () => {
    const { session, sent } = fakeSession([focused])
    await type(session, '#name', 'x', true)
    const keys = sent.filter((each) => each.method === 'Input.dispatchKeyEvent')
    expect(keys[0].params).toMatchObject({ commands: ['selectAll'] })
    expect(keys[2].params).toMatchObject({ key: 'x' })
  })

  // reason: a field emptied on the way is a field a component sees empty —
  // and one of them answers that by unmounting the form around it. Typing
  // over the selection never leaves it blank.
  it('never empties the field on the way to replacing it', async () => {
    const { session, sent } = fakeSession([focused])
    await type(session, '#date', '25 Aug 2026', true)
    const keys = sent.filter((each) => each.method === 'Input.dispatchKeyEvent')
    expect(keys.some((each) => each.params?.code === 'Backspace')).toBe(false)
  })

  it('deletes the selection when the replacement is empty', async () => {
    const { session, sent } = fakeSession([focused])
    await type(session, '#name', '', true)
    const keys = sent.filter((each) => each.method === 'Input.dispatchKeyEvent')
    expect(keys[0].params).toMatchObject({ commands: ['selectAll'] })
    expect(keys[2].params).toMatchObject({ code: 'Backspace' })
  })

  it('leaves the field alone when not told to clear it', async () => {
    const { session, sent } = fakeSession([focused])
    await type(session, '#name', 'x', false)
    expect(sent.some((each) => (each.params as { commands?: string[] })?.commands !== undefined)).toBe(false)
  })

  // reason: typing lands wherever focus is, so typing into something that
  // did not take focus writes into whatever did.
  it('refuses when the element did not take focus', async () => {
    const { session, sent } = fakeSession([{ ok: true, value: { found: true, focused: false } }])
    expect(await type(session, 'div', 'x', false)).toMatchObject({ ok: false })
    expect(sent.filter((each) => each.method === 'Input.dispatchKeyEvent')).toEqual([])
  })

  it('refuses a field it cannot find', async () => {
    const { session } = fakeSession([MISSING])
    expect(await type(session, '#name', 'x', false)).toEqual({ ok: false, reason: '#name: no element matches' })
  })

  it('refuses more text than one call sends', async () => {
    const { session, sent } = fakeSession([focused])
    expect(await type(session, '#name', 'x'.repeat(TYPE_LIMIT + 1), false)).toMatchObject({ ok: false })
    expect(sent).toEqual([])
  })

  it('inserts a character that has no key of its own', async () => {
    const { session, sent } = fakeSession([focused])
    await type(session, '#name', '✅', false)
    expect(sent.filter((each) => each.method === 'Input.insertText')).toHaveLength(1)
  })
})

describe('press', () => {
  it('sends a raw press for a key that inserts nothing', async () => {
    const { session, sent } = fakeSession()
    expect(await press(session, 'Escape')).toEqual({ ok: true, message: 'Pressed Escape.' })
    expect(sent.map((each) => each.params?.type)).toEqual(['rawKeyDown', 'keyUp'])
  })

  it('sends a text-carrying press for a key that inserts one', async () => {
    const { session, sent } = fakeSession()
    await press(session, 'Enter')
    expect(sent[0].params).toMatchObject({ type: 'keyDown', text: '\r' })
  })

  // reason: select-all is an editor command, not a page behaviour; without it
  // the key is pressed, nothing is selected, and a delete after it removes
  // one character.
  it('carries the editing command a shortcut means', async () => {
    const { session, sent } = fakeSession()
    await press(session, 'Meta+a')
    expect(sent[0].params).toMatchObject({ type: 'rawKeyDown', commands: ['selectAll'] })
    // Only on the press: a key release that repeated it would select twice.
    expect(sent[1].params?.commands).toBeUndefined()
  })

  it('carries no command for an ordinary key', async () => {
    const { session, sent } = fakeSession()
    await press(session, 'Enter')
    expect(sent[0].params?.commands).toBeUndefined()
  })

  it('refuses a name that is not a key', async () => {
    const { session, sent } = fakeSession()
    expect(await press(session, 'Retrun')).toEqual({ ok: false, reason: 'Retrun is not a key.' })
    expect(sent).toEqual([])
  })
})

describe('drag', () => {
  const both = { '#from': AT, '#to': ELSEWHERE }

  it('presses, moves in steps with the button held, then releases at the target', async () => {
    const { session, sent } = targetedSession(both)
    expect(await drag(session, '#from', '#to')).toEqual({ ok: true, message: 'Dragged button to div.' })
    const mouse = sent.filter((each) => each.method === 'Input.dispatchMouseEvent')
    expect(mouse[0].params).toMatchObject({ type: 'mouseMoved', buttons: 0 })
    expect(mouse[1].params).toMatchObject({ type: 'mousePressed', x: 30, y: 40 })
    const moves = mouse.slice(2, -1)
    // reason: a press and a release at two points is not a drag — the
    // libraries under test start only once the pointer has moved.
    expect(moves.length).toBeGreaterThan(4)
    expect(moves.every((each) => each.params?.buttons === 1)).toBe(true)
    expect(mouse.at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 200, y: 300 })
  })

  it('interpolates between the two points rather than jumping', async () => {
    const { session, sent } = targetedSession(both)
    await drag(session, '#from', '#to')
    const xs = sent
      .filter((each) => each.method === 'Input.dispatchMouseEvent' && each.params?.type === 'mouseMoved')
      .map((each) => each.params?.x as number)
    expect(xs.at(-1)).toBe(200)
    expect(xs.some((x) => x > 30 && x < 200)).toBe(true)
  })

  it('reads both ends in one scroll position', async () => {
    const { session, sent } = targetedSession(both)
    await drag(session, '#from', '#to')
    const reads = sent.filter((each) => each.method === 'evaluate')
    // Scroll to the source once, then measure everything without scrolling
    // again — including the source, which late content may have moved.
    expect(reads[0].params?.expression).toContain('true) element.scrollIntoView')
    for (const read of reads.slice(1)) {
      expect(read.params?.expression).toContain('false) element.scrollIntoView')
    }
  })

  // reason: a page still loading adverts moves everything below them, and an
  // element measured mid-shift is measured where the page is about to stop
  // drawing it — so the press lands on nothing and the drag silently does
  // nothing at all.
  it('waits for the source to stop moving before pressing on it', async () => {
    const places = [100, 200, 300, 300, 300]
    let read = 0
    const { session, sent } = targetedSession(both)
    const original = session.evaluate.bind(session)
    session.evaluate = async (expression: string) => {
      const answer = await original(expression)
      if (!expression.includes('"#from"')) return answer
      const y = places[Math.min(read, places.length - 1)]
      read += 1
      return { ok: true, value: { found: true, x: 30, y, tag: 'div', type: '', text: '' } }
    }
    await drag(session, '#from', '#to')
    expect(sent.find((each) => each.params?.type === 'mousePressed')?.params?.y).toBe(300)
  })

  // reason: late content arrives in bursts, and two reads taken between two
  // bursts agree with each other while the page is still moving.
  it('does not believe a single pair of agreeing reads', async () => {
    const places = [100, 100, 400, 400, 400]
    let read = 0
    const { session, sent } = targetedSession(both)
    const original = session.evaluate.bind(session)
    session.evaluate = async (expression: string) => {
      const answer = await original(expression)
      if (!expression.includes('"#from"')) return answer
      const y = places[Math.min(read, places.length - 1)]
      read += 1
      return { ok: true, value: { found: true, x: 30, y, tag: 'div', type: '', text: '' } }
    }
    await drag(session, '#from', '#to')
    expect(sent.find((each) => each.params?.type === 'mousePressed')?.params?.y).toBe(400)
  })

  it('drags from the last known place rather than waiting forever', async () => {
    let y = 0
    const session = {
      evaluate: async () => {
        y += 10
        return { ok: true as const, value: { found: true, x: 30, y, tag: 'div', type: '', text: '' } }
      },
      send: async () => ({}),
      next: async () => undefined,
    } as unknown as BrowserSession
    await expect(drag(session, '#from', '#to')).resolves.toMatchObject({ ok: true })
  })

  // reason: a page whose adverts finish loading mid-drag moves everything
  // under the pointer, and the point measured beforehand is then on whatever
  // took the target's place.
  it('releases where the target is by the end, not where it started', async () => {
    let read = 0
    const { session, sent } = targetedSession(both)
    const original = session.evaluate.bind(session)
    session.evaluate = async (expression: string) => {
      if (!expression.includes('"#to"')) return await original(expression)
      read += 1
      return read === 1
        ? ELSEWHERE
        : { ok: true, value: { found: true, x: 200, y: 500, tag: 'div', type: '', text: 'Drop' } }
    }
    await drag(session, '#from', '#to')
    const mouse = sent.filter((each) => each.method === 'Input.dispatchMouseEvent')
    expect(mouse.at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 200, y: 500 })
  })

  it('releases where it aimed when the target can no longer be found', async () => {
    let read = 0
    const { session, sent } = targetedSession(both)
    const original = session.evaluate.bind(session)
    session.evaluate = async (expression: string) => {
      if (!expression.includes('"#to"')) return await original(expression)
      read += 1
      return read === 1 ? ELSEWHERE : MISSING
    }
    expect(await drag(session, '#from', '#to')).toMatchObject({ ok: true })
    const mouse = sent.filter((each) => each.method === 'Input.dispatchMouseEvent')
    expect(mouse.at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 200, y: 300 })
  })

  it('says both ends have to be visible at once when the target is off screen', async () => {
    const { session } = targetedSession({
      '#from': AT,
      '#to': { ok: true, value: { found: false, reason: 'the element is off screen even after scrolling to it' } },
    })
    const result = await drag(session, '#from', '#to')
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.reason).toContain('both ends of a drag have to be visible at once')
  })

  it('presses nothing when the drop target is missing', async () => {
    const { session, sent } = targetedSession({ '#from': AT, '#to': MISSING })
    expect(await drag(session, '#from', '#to')).toMatchObject({ ok: false })
    expect(sent.filter((each) => each.method === 'Input.dispatchMouseEvent')).toEqual([])
  })

  // reason: a page using the HTML5 drag API — react-dnd, and most React
  // sortables — hands the pointer to Chromium on the first move, and every
  // mouse event after that is swallowed. The rest of the path has to be sent
  // as drag events or nothing arrives at the drop target.
  describe('when the page starts a native drag', () => {
    const intercept = { 'Input.dragIntercepted': { data: { items: [] } } }

    it('carries the path across as drag events and drops at the target', async () => {
      const { session, sent } = targetedSession(both, {}, intercept)
      expect(await drag(session, '#from', '#to')).toEqual({
        ok: true,
        message: 'Dragged button to div, as an HTML5 drag.',
      })
      const drags = sent.filter((each) => each.method === 'Input.dispatchDragEvent')
      expect(drags[0].params).toMatchObject({ type: 'dragEnter', data: { items: [] } })
      // reason: a drop target registers itself on `dragenter` and only then
      // reads `dragover`, so entering once at the start means every element
      // the path crosses afterwards is never listening.
      expect(drags.filter((each) => each.params?.type === 'dragEnter').length).toBeGreaterThan(4)
      expect(drags.filter((each) => each.params?.type === 'dragOver').length).toBeGreaterThan(4)
      expect(drags.at(-1)?.params).toMatchObject({ type: 'drop', x: 200, y: 300 })
    })

    it('never releases the mouse, since Chromium owns the pointer', async () => {
      const { session, sent } = targetedSession(both, {}, intercept)
      await drag(session, '#from', '#to')
      expect(sent.filter((each) => each.params?.type === 'mouseReleased')).toEqual([])
    })

    // reason: left on, the next drag on the page is caught and never
    // completed — including one the user makes with their own mouse.
    it('stops intercepting afterwards', async () => {
      const { session, sent } = targetedSession(both, {}, intercept)
      await drag(session, '#from', '#to')
      expect(sent.filter((each) => each.method === 'Input.setInterceptDrags').map((each) => each.params)).toEqual([
        { enabled: true },
        { enabled: false },
      ])
    })

    it('stops intercepting even when the drop fails', async () => {
      const { session, sent } = targetedSession(
        both,
        { 'Input.dispatchDragEvent': new Error('target closed') },
        intercept,
      )
      await expect(drag(session, '#from', '#to')).rejects.toThrow('target closed')
      expect(sent.at(-1)).toEqual({ method: 'Input.setInterceptDrags', params: { enabled: false } })
    })
  })

  it('uses the pointer when the page starts no native drag, and stops intercepting', async () => {
    const { session, sent } = targetedSession(both)
    await drag(session, '#from', '#to')
    expect(sent.some((each) => each.method === 'Input.dispatchDragEvent')).toBe(false)
    expect(sent.some((each) => each.params?.type === 'mouseReleased')).toBe(true)
    expect(sent.filter((each) => each.method === 'Input.setInterceptDrags').map((each) => each.params)).toEqual([
      { enabled: true },
      { enabled: false },
    ])
  })
})

/**
 * A gesture held open across calls.
 *
 * The one-shot `drag` commits to its whole path before the first move, so it
 * cannot see what the page did in the middle of it — which is the difference
 * between landing on the third row of a sortable and landing on the second.
 * These let the caller move, read the page, and move again.
 */
describe('a drag held open across calls', () => {
  const both = { '#from': AT, '#to': ELSEWHERE }
  const intercept = { 'Input.dragIntercepted': { data: { items: [] } } }

  it('presses and holds, without releasing or dropping', async () => {
    const { session, sent } = targetedSession(both)
    expect(await dragStart(session, '#from')).toEqual({ ok: true, message: 'Holding button. Move, then drop.' })
    const mouse = sent.filter((each) => each.method === 'Input.dispatchMouseEvent')
    // The third is the probe: an HTML5 drag source starts on the first move,
    // so the press alone cannot tell which kind of drag the page took it as.
    expect(mouse.map((each) => each.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved'])
    expect(sent.some((each) => each.params?.type === 'mouseReleased')).toBe(false)
    expect(sent.some((each) => each.method === 'Input.dispatchDragEvent')).toBe(false)
    await dragCancel(session)
  })

  it('refuses a move and a drop when nothing is being held', async () => {
    const { session } = targetedSession(both)
    expect(await dragMove(session, '#to')).toEqual({ ok: false, reason: 'Nothing is being dragged. Start one first.' })
    expect(await dragDrop(session, '#to')).toEqual({ ok: false, reason: 'Nothing is being dragged. Start one first.' })
  })

  // reason: the point of holding one open is to read the page between moves,
  // which only works if each move is its own path rather than a jump.
  it('moves in steps with the button held, and still holds afterwards', async () => {
    const { session, sent } = targetedSession(both)
    await dragStart(session, '#from')
    const before = sent.length
    expect(await dragMove(session, '#to')).toEqual({ ok: true, message: 'Moved to div. Still holding.' })
    const moves = sent.slice(before).filter((each) => each.params?.type === 'mouseMoved')
    expect(moves.length).toBeGreaterThan(4)
    expect(sent.some((each) => each.params?.type === 'mouseReleased')).toBe(false)
    await dragCancel(session)
  })

  it('releases at the drop, and forgets the gesture', async () => {
    const { session, sent } = targetedSession(both)
    await dragStart(session, '#from')
    await dragMove(session, '#to')
    expect(await dragDrop(session, '#to')).toEqual({ ok: true, message: 'Dropped on div.' })
    expect(sent.filter((each) => each.method === 'Input.dispatchMouseEvent').at(-1)?.params).toMatchObject({
      type: 'mouseReleased',
    })
    expect(await dragMove(session, '#to')).toEqual({ ok: false, reason: 'Nothing is being dragged. Start one first.' })
  })

  it('moves by an offset when nothing is named, which is what a resize handle needs', async () => {
    const { session, sent } = targetedSession(both)
    await dragStart(session, '#from')
    const before = sent.length
    expect(await dragMove(session, undefined, { dx: 60, dy: 0 })).toEqual({
      ok: true,
      message: 'Moved by 60 across and 0 down. Still holding.',
    })
    expect(sent.slice(before).filter((each) => each.params?.type === 'mouseMoved').at(-1)?.params).toMatchObject({
      x: 90,
      y: 40,
    })
    await dragCancel(session)
  })

  // reason: a second start would press a button already down, and the page
  // would see a press with no release between two drags.
  it('refuses to start a second gesture while one is held', async () => {
    const { session } = targetedSession(both)
    await dragStart(session, '#from')
    expect(await dragStart(session, '#from')).toEqual({
      ok: false,
      reason: 'A drag is already being held. Drop it or cancel it first.',
    })
    await dragCancel(session)
  })

  it('releases the button and stops intercepting when cancelled', async () => {
    const { session, sent } = targetedSession(both)
    await dragStart(session, '#from')
    expect(await dragCancel(session)).toEqual({ ok: true, message: 'Cancelled the drag.' })
    expect(sent.some((each) => each.params?.type === 'mouseReleased')).toBe(true)
    expect(sent.filter((each) => each.method === 'Input.setInterceptDrags').at(-1)?.params).toEqual({ enabled: false })
  })

  it('says so when there is nothing to cancel', async () => {
    const { session, sent } = targetedSession(both)
    expect(await dragCancel(session)).toEqual({ ok: false, reason: 'Nothing is being dragged.' })
    expect(sent).toEqual([])
  })

  describe('when the page starts a native drag', () => {
    it('reports it, and carries later moves across as drag events', async () => {
      const { session, sent } = targetedSession(both, {}, intercept)
      expect(await dragStart(session, '#from')).toEqual({
        ok: true,
        message: 'Holding button, as an HTML5 drag. Move, then drop.',
      })
      const before = sent.length
      await dragMove(session, '#to')
      const drags = sent.slice(before).filter((each) => each.method === 'Input.dispatchDragEvent')
      expect(drags.filter((each) => each.params?.type === 'dragEnter').length).toBeGreaterThan(4)
      expect(drags.filter((each) => each.params?.type === 'dragOver').length).toBeGreaterThan(4)
      expect(sent.slice(before).some((each) => each.params?.type === 'mouseMoved')).toBe(false)
      await dragCancel(session)
    })

    it('drops as a drag event, and never releases the mouse', async () => {
      const { session, sent } = targetedSession(both, {}, intercept)
      await dragStart(session, '#from')
      expect(await dragDrop(session, '#to')).toEqual({ ok: true, message: 'Dropped on div, as an HTML5 drag.' })
      expect(sent.filter((each) => each.method === 'Input.dispatchDragEvent').at(-1)?.params).toMatchObject({
        type: 'drop',
      })
      expect(sent.some((each) => each.params?.type === 'mouseReleased')).toBe(false)
    })

    // reason: left intercepting, the next drag on the page is caught and
    // never completed — including one the user makes with their own mouse.
    it('stops intercepting once dropped', async () => {
      const { session, sent } = targetedSession(both, {}, intercept)
      await dragStart(session, '#from')
      await dragDrop(session, '#to')
      expect(sent.filter((each) => each.method === 'Input.setInterceptDrags').at(-1)?.params).toEqual({
        enabled: false,
      })
    })

    it('cancels with a dragCancel rather than a release', async () => {
      const { session, sent } = targetedSession(both, {}, intercept)
      await dragStart(session, '#from')
      await dragCancel(session)
      expect(sent.filter((each) => each.method === 'Input.dispatchDragEvent').at(-1)?.params).toMatchObject({
        type: 'dragCancel',
      })
      expect(sent.some((each) => each.params?.type === 'mouseReleased')).toBe(false)
    })
  })
})

describe('selectOption', () => {
  it('reports what the page selected', async () => {
    const { session } = fakeSession([{ ok: true, value: { ok: true, selected: 'Show 20' } }])
    expect(await selectOption(session, '#rows', 'Show 20')).toEqual({ ok: true, message: 'Selected "Show 20".' })
  })

  it('passes on the reason the page gave for refusing', async () => {
    const { session } = fakeSession([{ ok: true, value: { ok: false, reason: 'no such option' } }])
    expect(await selectOption(session, '#rows', 'Show 50')).toEqual({ ok: false, reason: '#rows: no such option' })
  })
})

describe('uploadFile', () => {
  it('sets the files on the node the selector matches', async () => {
    const { session, sent } = fakeSession([], {
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 9 },
    })
    expect(await uploadFile(session, '#uploadPicture', ['/tmp/a.png'])).toEqual({
      ok: true,
      message: 'Attached /tmp/a.png.',
    })
    expect(sent.at(-1)).toEqual({
      method: 'DOM.setFileInputFiles',
      params: { files: ['/tmp/a.png'], nodeId: 9 },
    })
  })

  it('resolves a reference to the attribute the snapshot wrote', async () => {
    const { session, sent } = fakeSession([], {
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 9 },
    })
    await uploadFile(session, 'ref=4', ['/tmp/a.png'])
    expect(sent[2].params?.selector).toBe('[data-dsh-ref="4"]')
  })

  it('attaches nothing when the selector matches nothing', async () => {
    const { session, sent } = fakeSession([], {
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 0 },
    })
    expect(await uploadFile(session, '#absent', ['/tmp/a.png'])).toMatchObject({ ok: false })
    expect(sent.some((each) => each.method === 'DOM.setFileInputFiles')).toBe(false)
  })

  it('refuses a target it cannot write as a selector', async () => {
    const { session, sent } = fakeSession()
    expect(await uploadFile(session, 'text=Choose', ['/tmp/a.png'])).toMatchObject({ ok: false })
    expect(sent).toEqual([])
  })
})

describe('resizeViewport', () => {
  it('overrides what the page measures', async () => {
    const { session, sent } = fakeSession()
    expect(await resizeViewport(session, 1600, 900)).toEqual({
      ok: true,
      message: 'The page now measures 1600×900.',
    })
    expect(sent[0]).toEqual({
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false },
    })
  })

  it('clears the override when given no size', async () => {
    const { session, sent } = fakeSession()
    await resizeViewport(session, 0, 0)
    expect(sent[0].method).toBe('Emulation.clearDeviceMetricsOverride')
  })
})

describe('screenshot', () => {
  it('returns the image the protocol captured', async () => {
    const { session } = fakeSession([], { 'Page.captureScreenshot': { data: 'iVBOR' } })
    expect(await screenshot(session)).toEqual({ ok: true, png: 'iVBOR' })
  })

  it('reports a capture that failed', async () => {
    const { session } = fakeSession([], { 'Page.captureScreenshot': new Error('no target') })
    expect(await screenshot(session)).toEqual({ ok: false, reason: 'no target' })
  })
})

describe('readPage', () => {
  it('returns the numbered elements under the page it read', async () => {
    const { session } = fakeSession([
      { ok: true, value: { url: 'https://demoqa.com/', title: 'Demo', elements: 'ref=1 button "Go"' } },
    ])
    expect(await readPage(session)).toEqual({
      ok: true,
      message: '# Demo\nhttps://demoqa.com/\n\nref=1 button "Go"',
    })
  })
})

describe('waitFor', () => {
  it('returns as soon as the condition holds', async () => {
    let asked = 0
    const session = {
      evaluate: async () => {
        asked += 1
        return { ok: true as const, value: asked >= 3 }
      },
      send: async () => ({}),
      next: async () => undefined,
    } as unknown as BrowserSession
    const result = await waitFor(session, '#done', undefined, false, 5)
    expect(result).toMatchObject({ ok: true })
    expect(asked).toBe(3)
  })

  it('gives up after the time it was given', async () => {
    const session = {
      evaluate: async () => ({ ok: true as const, value: false }),
      send: async () => ({}),
      next: async () => undefined,
    } as unknown as BrowserSession
    const result = await waitFor(session, '#done', undefined, false, 1)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.reason).toContain('still missing after 1s')
  })

  // reason: a page mid-navigation cannot answer, which is not a reason to
  // stop waiting for what will be on the page after it.
  it('keeps waiting through a page that cannot answer', async () => {
    let asked = 0
    const session = {
      evaluate: async () => {
        asked += 1
        return asked < 3 ? { ok: false as const, reason: 'target closed' } : { ok: true as const, value: true }
      },
      send: async () => ({}),
      next: async () => undefined,
    } as unknown as BrowserSession
    await expect(waitFor(session, '#done', undefined, false, 5)).resolves.toMatchObject({ ok: true })
  })

  it('waits for text as well as for an element', async () => {
    const seen: string[] = []
    const session = {
      evaluate: async (expression: string) => {
        seen.push(expression)
        return { ok: true as const, value: true }
      },
      send: async () => ({}),
      next: async () => undefined,
    } as unknown as BrowserSession
    await waitFor(session, undefined, 'Saved', false, 5)
    expect(seen[0]).toContain('innerText')
    expect(seen[0]).toContain('"Saved"')
  })

  // reason: a page that acts on a timer gives nothing to wait for but the
  // time itself, and inventing a condition that never matches to wait it out
  // reports a failure for a step that did what was asked.
  it('waits for the time to pass when nothing in particular is named', async () => {
    const { session, sent } = fakeSession()
    const result = await waitFor(session, undefined, undefined, false, 1)
    expect(result).toEqual({ ok: true, message: 'Waited 1s.' })
    expect(sent).toEqual([])
  })
})

describe('drag by an offset', () => {
  // reason: a resize handle is dragged by a distance, and the nearest element
  // to that distance is not the same thing.
  it('drags from the source by the offset when no target is named', async () => {
    const { session, sent } = targetedSession({ '#handle': AT })
    expect(await drag(session, '#handle', undefined, { dx: 50, dy: 30 })).toEqual({
      ok: true,
      message: 'Dragged button to button offset by 50, 30.',
    })
    const mouse = sent.filter((each) => each.method === 'Input.dispatchMouseEvent')
    expect(mouse.at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 80, y: 70 })
  })

  it('adds the offset to a named target', async () => {
    const { session, sent } = targetedSession({ '#from': AT, '#to': ELSEWHERE })
    await drag(session, '#from', '#to', { dx: -10, dy: 5 })
    const mouse = sent.filter((each) => each.method === 'Input.dispatchMouseEvent')
    expect(mouse.at(-1)?.params).toMatchObject({ x: 190, y: 305 })
  })

  it('refuses a drag that names neither a target nor a distance', async () => {
    const { session, sent } = targetedSession({ '#from': AT })
    expect(await drag(session, '#from', undefined, { dx: 0, dy: 0 })).toMatchObject({ ok: false })
    expect(sent).toEqual([])
  })
})
