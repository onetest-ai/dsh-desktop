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
 * Ids `settings.html` marks `hidden` in the markup itself, so the fixture's
 * initial state matches what a real DOM parse would give `element.hidden`
 * before any script runs.
 * @returns the ids of every tag declaring the `hidden` attribute.
 */
function declaredHiddenIds(): Set<string> {
  const ids = new Set<string>()
  for (const match of MARKUP.matchAll(/<[a-z]+\b[^>]*>/g)) {
    const tag = match[0]
    if (!/\bhidden\b/.test(tag)) continue
    const id = /\bid="([^"]+)"/.exec(tag)?.[1]
    if (id !== undefined) ids.add(id)
  }
  return ids
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
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npmPath']

interface FakeElement {
  id: string
  value: string
  textContent: string
  hidden: boolean
  disabled: boolean
  checked: boolean
  scrollTop: number
  scrollHeight: number
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
    scrollTop: 0,
    scrollHeight: 0,
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
  useLatest(): Promise<void>
  /** Fires the preload's `onProgress` subscription as main would push a line. */
  pushProgress(line: string): void
  /** Fires the preload's `onUpdateAvailable` subscription as main would push a result. */
  pushUpdateAvailable(latest: string): void
}

/**
 * Load `settings.js` over a fake document.
 * @param onSave - what the `settings.save` bridge call does.
 * @param onRead - what the `settings.read` bridge call does; defaults to a
 *   configured local source with empty fields.
 * @returns the fake elements and a way to fire the save button.
 */
async function load(onSave: SaveOutcome, onRead?: () => Promise<unknown>): Promise<Renderer> {
  const hiddenIds = declaredHiddenIds()
  const elements = new Map(
    declaredIds().map((id) => {
      const node = element(id)
      node.hidden = hiddenIds.has(id)
      return [id, node]
    }),
  )
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

  let progressListener: ((line: string) => void) | undefined
  let updateListener: ((latest: string) => void) | undefined
  const settings = {
    read: vi.fn(
      onRead ??
        (async () => ({
          configured: true,
          form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
        })),
    ),
    pickFolder: vi.fn(async () => undefined),
    save: vi.fn(onSave),
    onProgress: vi.fn((listener: (line: string) => void) => {
      progressListener = listener
    }),
    onUpdateAvailable: vi.fn((listener: (latest: string) => void) => {
      updateListener = listener
    }),
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
    useLatest: async () => {
      await elements.get('use-latest')?.listeners.get('click')?.()
    },
    pushProgress: (line) => progressListener?.(line),
    pushUpdateAvailable: (latest) => updateListener?.(latest),
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

  it('declares a managed source radio, not the old npx one', () => {
    expect(declaredKindRadios().map((radio) => radio.value)).toEqual(['local', 'managed'])
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

describe('install progress', () => {
  it('appends each pushed line and reveals the progress node', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    const progress = renderer.elements.get('progress')
    expect(progress?.hidden).toBe(true)

    renderer.pushProgress('added 455 packages')
    renderer.pushProgress('found 0 vulnerabilities')

    expect(progress?.hidden).toBe(false)
    expect(progress?.textContent).toBe('added 455 packages\nfound 0 vulnerabilities')
  })

  it('clears previous progress when a new save starts', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    renderer.pushProgress('added 455 packages')
    await renderer.save()

    expect(renderer.elements.get('progress')?.textContent).toBe('')
    expect(renderer.elements.get('progress')?.hidden).toBe(true)
  })
})

describe('update available', () => {
  it('reveals the hint with the pushed version', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    renderer.pushUpdateAvailable('0.2.0')

    expect(renderer.elements.get('update-hint')?.hidden).toBe(false)
    expect(renderer.elements.get('latest-version')?.textContent).toBe('0.2.0')
  })

  it('using it fills in the version and saves', async () => {
    const save = vi.fn(async () => ({ ok: true, warnings: [] }))
    const renderer = await load(save)
    renderer.pushUpdateAvailable('0.2.0')

    await renderer.useLatest()

    expect(renderer.elements.get('version')?.value).toBe('0.2.0')
    expect(save).toHaveBeenCalled()
  })
})

describe('load', () => {
  it('explains a rejected read instead of presenting the defaults as the stored config', async () => {
    // The form's markup defaults are an empty local checkout. Left unexplained
    // they claim to be the user's configuration, which is what makes a broken
    // config look like no config at all.
    const renderer = await load(
      async () => ({ ok: true, warnings: [] }),
      () => Promise.reject(new Error('dsh-desktop: npm is not on PATH')),
    )

    const status = renderer.elements.get('status')
    expect(status?.textContent).toContain('could not be read')
    expect(status?.textContent).toContain('npm is not on PATH')
    expect(status?.classes.has('status-failed')).toBe(true)
    expect(renderer.elements.get('intro')?.textContent).not.toBe('')
  })

  it('leaves Save usable after a failed read, since this is the repair screen', async () => {
    const renderer = await load(
      async () => ({ ok: true, warnings: [] }),
      () => Promise.reject(new Error('dsh-desktop: npm is not on PATH')),
    )

    expect(renderer.elements.get('save')?.disabled).toBe(false)
    await renderer.save()

    expect(renderer.elements.get('status')?.textContent).toBe('Settings saved.')
  })
})
