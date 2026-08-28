// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  REF_ATTRIBUTE,
  SNAPSHOT_LIMIT,
  focusScript,
  locateScript,
  selectOptionScript,
  snapshotScript,
} from './browser-script'

/**
 * Run one of these scripts against a document, as `Runtime.evaluate` does.
 * @param html - the body markup to run it against, or undefined to keep what
 *   the previous call left.
 * @param source - the script.
 * @returns what the script returned.
 */
function run<T>(html: string | undefined, source: string): T {
  if (html !== undefined) document.body.innerHTML = html
  // jsdom lays nothing out, so every rect is zero and the scripts' own
  // "is it on screen" check would reject everything. A real box per element
  // is the closest stand-in for a rendered page.
  for (const element of document.querySelectorAll('*')) {
    if (element.getBoundingClientRect.name === 'stub') continue
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: Object.defineProperty(
        () => ({ left: 10, top: 20, width: 100, height: 40 }),
        'name',
        { value: 'stub' },
      ),
    })
    Object.defineProperty(element, 'scrollIntoView', { configurable: true, value: () => {} })
  }
  return eval(source) as T
}

/**
 * Say what is at the point a click would be dispatched at.
 *
 * jsdom lays nothing out, so its own `elementFromPoint` has nothing to answer
 * from; the scripts read it to refuse a click that would land on whatever is
 * covering the target.
 * @param element - what to report as being there, by selector, or null for
 *   nothing at all.
 */
function atPoint(element: string | null): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => (element === null ? null : document.querySelector(element)),
  })
}

describe('locateScript', () => {
  // Nothing covering anything, unless a test says otherwise: jsdom cannot
  // answer this itself, and the scripts refuse a click they cannot see land.
  beforeEach(() => {
    // The root contains every element, which is the "a wrapper received the
    // click" case the scripts accept.
    atPoint('html')
  })

  it('finds an element by CSS selector and returns its centre', () => {
    expect(run('<button id="go">Go</button>', locateScript('#go'))).toEqual({
      found: true,
      x: 60,
      y: 40,
      tag: 'button',
      type: '',
      text: 'Go',
    })
  })

  it('finds an element by its visible text', () => {
    const out = run<{ found: boolean; tag: string }>('<div><button>Submit</button></div>', locateScript('text=Submit'))
    expect(out).toMatchObject({ found: true, tag: 'button' })
  })

  // reason: a wrapper whose only content is the target matches the text too,
  // and clicking the wrapper is not what was asked for.
  it('prefers the deepest element matching the text', () => {
    const out = run<{ tag: string }>('<div><span><a href="#">Open</a></span></div>', locateScript('text=Open'))
    expect(out.tag).toBe('a')
  })

  it('finds an element by a reference a snapshot left', () => {
    run('<button>One</button><button>Two</button>', snapshotScript(SNAPSHOT_LIMIT))
    const out = run<{ text: string }>(undefined, locateScript('ref=2'))
    expect(out.text).toBe('Two')
  })

  it('says an element is missing rather than throwing', () => {
    expect(run('<p>nothing here</p>', locateScript('#absent'))).toMatchObject({ found: false })
  })

  it('says a malformed selector matched nothing rather than throwing', () => {
    expect(run('<p>x</p>', locateScript('>>>'))).toMatchObject({ found: false })
  })

  // reason: an advertisement over a button takes the click meant for the
  // button, and the page then reports nothing happening for a reason no
  // amount of retrying explains.
  it('refuses a click that would land on whatever is covering the element', () => {
    document.body.innerHTML = '<button id="go">Go</button><div id="advert" class="ad wide">buy</div>'
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => ({ left: 10, top: 20, width: 100, height: 40 }),
      })
      Object.defineProperty(element, 'scrollIntoView', { value: () => {} })
    }
    atPoint('#advert')
    const out = eval(locateScript('#go')) as { found: boolean; reason: string }
    expect(out.found).toBe(false)
    expect(out.reason).toContain('div#advert.ad.wide')
  })

  it('accepts a click landing on something inside the element', () => {
    document.body.innerHTML = '<button id="go"><span id="inner">Go</span></button>'
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => ({ left: 10, top: 20, width: 100, height: 40 }),
      })
      Object.defineProperty(element, 'scrollIntoView', { value: () => {} })
    }
    atPoint('#inner')
    expect(eval(locateScript('#go'))).toMatchObject({ found: true })
  })

  // reason: an element at the end of a short page cannot be centred, and a
  // point past the viewport edge hits nothing at all.
  it('takes the point from the part of the element that is on screen', () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go') as HTMLElement
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: window.innerHeight - 10, width: 100, height: 40 }),
    })
    Object.defineProperty(button, 'scrollIntoView', { value: () => {} })
    atPoint('html')
    const out = eval(locateScript('#go')) as { found: boolean; y: number }
    expect(out.found).toBe(true)
    expect(out.y).toBeLessThan(window.innerHeight)
  })

  it('refuses an element scrolling could not bring on screen', () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go') as HTMLElement
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: window.innerHeight + 20, width: 100, height: 40 }),
    })
    Object.defineProperty(button, 'scrollIntoView', { value: () => {} })
    atPoint('html')
    expect(eval(locateScript('#go'))).toMatchObject({ found: false })
  })

  // reason: a page that sets `scroll-behavior: smooth` makes scrollIntoView
  // asynchronous, so the rectangle read straight after it is the one from
  // before the scroll.
  it('scrolls instantly, so the position it reads is the one after scrolling', () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go') as HTMLElement
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 20, width: 100, height: 40 }),
    })
    let asked: { behavior?: string } | undefined
    Object.defineProperty(button, 'scrollIntoView', {
      value: (options: { behavior?: string }) => {
        asked = options
      },
    })
    atPoint('html')
    eval(locateScript('#go'))
    expect(asked?.behavior).toBe('instant')
  })

  it('refuses an element with no size on screen', () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go') as HTMLElement
    Object.defineProperty(button, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 0, height: 0 }) })
    Object.defineProperty(button, 'scrollIntoView', { value: () => {} })
    expect(eval(locateScript('#go'))).toMatchObject({ found: false })
  })
})

describe('focusScript', () => {
  it('focuses a field', () => {
    run('<input id="name" value="old">', focusScript('#name', false))
    expect(document.activeElement?.id).toBe('name')
  })

  // reason: assigning `value` directly is invisible to a React-controlled
  // field, which is most of what this drives.
  it('clears through the prototype setter and announces the change', () => {
    document.body.innerHTML = '<input id="name" value="old">'
    const field = document.querySelector('#name') as HTMLInputElement
    Object.defineProperty(field, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 10, height: 10 }) })
    Object.defineProperty(field, 'scrollIntoView', { value: () => {} })
    const seen: string[] = []
    field.addEventListener('input', () => seen.push(field.value))
    eval(focusScript('#name', true))
    expect(field.value).toBe('')
    expect(seen).toEqual([''])
  })

  it('reports a field it cannot find', () => {
    expect(run('<p>x</p>', focusScript('#absent', true))).toMatchObject({ found: false })
  })
})

describe('selectOptionScript', () => {
  const html = '<select id="rows"><option value="10">Show 10</option><option value="20">Show 20</option></select>'

  it('selects by the label the user reads', () => {
    expect(run(html, selectOptionScript('#rows', 'Show 20'))).toEqual({ ok: true, selected: 'Show 20' })
    expect((document.querySelector('#rows') as HTMLSelectElement).value).toBe('20')
  })

  it('selects by value', () => {
    run(html, selectOptionScript('#rows', '20'))
    expect((document.querySelector('#rows') as HTMLSelectElement).value).toBe('20')
  })

  it('announces the change so a framework sees it', () => {
    document.body.innerHTML = html
    const select = document.querySelector('#rows') as HTMLSelectElement
    Object.defineProperty(select, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 1, height: 1 }) })
    const seen: string[] = []
    select.addEventListener('change', () => seen.push(select.value))
    eval(selectOptionScript('#rows', 'Show 20'))
    expect(seen).toEqual(['20'])
  })

  it('lists what it does have when the option is not there', () => {
    const out = run<{ ok: boolean; reason: string }>(html, selectOptionScript('#rows', 'Show 50'))
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('Show 10')
  })

  // reason: demoqa's State and City are react-select comboboxes that look
  // like selects and are driven by clicking.
  it('says so when the target is not a select at all', () => {
    const out = run<{ ok: boolean; reason: string }>('<div id="state">NCR</div>', selectOptionScript('#state', 'NCR'))
    expect(out).toMatchObject({ ok: false })
    expect(out.reason).toContain('click it instead')
  })
})

describe('snapshotScript', () => {
  it('numbers interactive elements with their role, name, and id', () => {
    const out = run<{ elements: string }>(
      '<button id="go">Go</button><input placeholder="Email"><a href="/x">Next</a>',
      snapshotScript(SNAPSHOT_LIMIT),
    )
    expect(out.elements.split('\n')).toEqual([
      'ref=1 button "Go" #go',
      'ref=2 input "Email"',
      'ref=3 a "Next"',
    ])
  })

  it('leaves the numbers on the elements for a later call to resolve', () => {
    run('<button>Go</button>', snapshotScript(SNAPSHOT_LIMIT))
    expect(document.querySelector('button')?.getAttribute(REF_ATTRIBUTE)).toBe('1')
  })

  it('renumbers from scratch, so a stale reference cannot be resolved', () => {
    run('<button>Go</button><button>Stop</button>', snapshotScript(SNAPSHOT_LIMIT))
    run('<button>Only</button>', snapshotScript(SNAPSHOT_LIMIT))
    expect(run(undefined, locateScript('ref=2'))).toMatchObject({ found: false })
  })

  it('reports a field value and a checked box', () => {
    const out = run<{ elements: string }>(
      '<input id="a" value="Olha"><input id="b" type="checkbox" checked>',
      snapshotScript(SNAPSHOT_LIMIT),
    )
    expect(out.elements).toContain('value="Olha"')
    expect(out.elements).toContain('checked')
  })

  // reason: a password echoed into the transcript is a password leaked to the
  // model and to anything that stores the conversation.
  it('never reports a password field value', () => {
    const out = run<{ elements: string }>(
      '<input id="p" type="password" value="hunter2">',
      snapshotScript(SNAPSHOT_LIMIT),
    )
    expect(out.elements).not.toContain('hunter2')
  })

  it('skips elements with no size on screen', () => {
    document.body.innerHTML = '<button id="shown">Go</button><button id="hidden">Nope</button>'
    for (const element of document.querySelectorAll('*')) {
      const size = element.id === 'hidden' ? 0 : 10
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => ({ left: 0, top: 0, width: size, height: size }),
      })
    }
    const out = eval(snapshotScript(SNAPSHOT_LIMIT)) as { elements: string }
    expect(out.elements).toBe('ref=1 button "Go" #shown')
  })

  it('stops at the limit and says it did', () => {
    const out = run<{ elements: string }>(
      '<button>a</button><button>b</button><button>c</button>',
      snapshotScript(2),
    )
    expect(out.elements.split('\n')).toHaveLength(3)
    expect(out.elements).toContain('more elements not listed')
  })
})
