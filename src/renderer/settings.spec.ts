import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/**
 * Tests for the settings renderer.
 *
 * `settings.js` is a plain script that reads the DOM and calls the preload
 * bridge, so it is run here in a VM over a fake document holding exactly the
 * elements `settings.html` declares. That keeps the renderer's one piece of
 * behavior — what the user is shown for each save outcome — under test without
 * a browser.
 */

const SOURCE = readFileSync(join(__dirname, 'settings.js'), 'utf8')
const MARKUP = readFileSync(join(__dirname, 'settings.html'), 'utf8')

/**
 * Every `id` `settings.html` declares.
 *
 * Derived from the page rather than restated, so the fixture cannot drift from
 * it: a hand-written list is what let `clearErrors` reference three error
 * nodes the real page has never had. `getElementById` returns null for
 * anything outside this set, exactly as the browser does.
 * @returns the declared ids.
 */
function declaredIds(): string[] {
  return [...MARKUP.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
}

/**
 * The `kind` radios the page declares, in document order.
 * @returns each radio's value and whether the markup marks it checked.
 */
function declaredKindRadios(): Array<{ value: string; checked: boolean }> {
  return [...MARKUP.matchAll(/<input([^>]*\bname="kind"[^>]*)>/g)].map((match) => ({
    value: /\bvalue="([^"]+)"/.exec(match[1])?.[1] ?? '',
    checked: /\bchecked\b/.test(match[1]),
  }))
}

/** The field ids `settings.js` collects; asserted against the page below. */
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npxPath']

interface FakeElement {
  id: string
  value: string
  textContent: string
  hidden: boolean
  disabled: boolean
  checked: boolean
  classes: Set<string>
  classList: { add(name: string): void; remove(name: string): void }
  addEventListener(name: string, handler: () => unknown): void
  listeners: Map<string, () => unknown>
}

function element(id: string): FakeElement {
  const classes = new Set<string>()
  const listeners = new Map<string, () => unknown>()
  return {
    id,
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    checked: false,
    classes,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    listeners,
    addEventListener: (name: string, handler: () => unknown) => listeners.set(name, handler),
  }
}

/** A save result or a rejection for the bridge to produce. */
type SaveOutcome = () => Promise<unknown>

/** The loaded renderer, plus the handles a test needs to drive and read it. */
interface Renderer {
  elements: Map<string, FakeElement>
  save(): Promise<void>
}

/**
 * Load `settings.js` over a fake document.
 * @param onSave - what the `settings.save` bridge call does.
 * @returns the fake elements and a way to fire the save button.
 */
async function load(onSave: SaveOutcome): Promise<Renderer> {
  const elements = new Map(declaredIds().map((id) => [id, element(id)]))
  const radios = declaredKindRadios().map((radio) => {
    const node = element(`kind-${radio.value}`)
    node.value = radio.value
    node.checked = radio.checked
    return node
  })

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => {
      if (selector !== 'input[name="kind"]:checked') throw new Error(`unexpected selector ${selector}`)
      return radios.find((radio) => radio.checked)
    },
    querySelectorAll: (selector: string) => {
      if (selector !== 'input[name="kind"]') throw new Error(`unexpected selector ${selector}`)
      return radios
    },
  }

  const settings = {
    read: vi.fn(async () => ({
      configured: true,
      form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
    })),
    pickFolder: vi.fn(async () => undefined),
    save: vi.fn(onSave),
  }

  const context: { window: { settings: unknown }; document: unknown } = {
    window: { settings },
    document,
  }
  runInNewContext(SOURCE, context)
  // Let the initial `load()` settle before a test touches the form.
  await Promise.resolve()
  await Promise.resolve()

  return {
    elements,
    save: async () => {
      await elements.get('save')?.listeners.get('click')?.()
    },
  }
}

describe('the page it runs against', () => {
  it('declares an input for every field the script collects', () => {
    expect(declaredIds()).toEqual(expect.arrayContaining(FIELDS))
  })

  it('declares error nodes for only some of those fields', () => {
    // The reason `clearErrors` must tolerate a missing node. If the page ever
    // gains all of them this fails, and the guard can be revisited on purpose.
    const withError = FIELDS.filter((name) => declaredIds().includes(`error-${name}`))
    expect(withError).not.toEqual(FIELDS)
  })

  it('matches the field list the script hard-codes', () => {
    expect(/const FIELDS = \[([^\]]+)\]/.exec(SOURCE)?.[1].match(/'([^']+)'/g)?.length).toBe(FIELDS.length)
  })
})

describe('save', () => {
  it('reports success', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    await renderer.save()
    expect(renderer.elements.get('status')?.textContent).toBe('Settings saved.')
  })

  it('shows a visible failure when the save rejects instead of silently looking saved', async () => {
    const renderer = await load(() =>
      Promise.reject(new Error("EACCES: permission denied, open 'desktop.json'")),
    )
    await renderer.save()

    const status = renderer.elements.get('status')
    // The user's only signal: errors and status were cleared and the button is
    // enabled again, so an empty status reads exactly like a successful save.
    expect(status?.textContent).toContain('not saved')
    expect(status?.textContent).toContain('EACCES')
    expect(status?.classes.has('status-failed')).toBe(true)
    expect(renderer.elements.get('save')?.disabled).toBe(false)
  })

  it('clears a previous failure on the next attempt', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    const status = renderer.elements.get('status')
    status?.classList.add('status-failed')
    if (status !== undefined) status.textContent = 'Settings were not saved. EACCES'
    await renderer.save()
    expect(status?.classes.has('status-failed')).toBe(false)
    expect(status?.textContent).toBe('Settings saved.')
  })
})
