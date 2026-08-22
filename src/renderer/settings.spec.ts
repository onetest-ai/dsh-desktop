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
 * behavior — what the user is shown for each save outcome, and now each Add
 * outcome — under test without a browser.
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
  tagName: string
  value: string
  textContent: string
  className: string
  hidden: boolean
  disabled: boolean
  checked: boolean
  scrollTop: number
  scrollHeight: number
  type: string
  classes: Set<string>
  classList: { add(name: string): void; remove(name: string): void }
  children: FakeElement[]
  append(child: FakeElement): void
  addEventListener(name: string, handler: () => unknown): void
  setAttribute(name: string, value: string): void
  listeners: Map<string, () => unknown>
}

function element(id: string): FakeElement {
  const classes = new Set<string>()
  const listeners = new Map<string, () => unknown>()
  let children: FakeElement[] = []
  let text = ''
  const node = {
    id,
    tagName: 'div',
    value: '',
    className: '',
    hidden: false,
    disabled: false,
    checked: false,
    scrollTop: 0,
    scrollHeight: 0,
    type: '',
    classes,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    // Setting `textContent`, like in a real DOM, replaces every child node —
    // `renderPluginRows` relies on exactly this to clear a stale row list
    // before re-rendering it.
    get textContent(): string {
      return text
    },
    set textContent(value: string) {
      text = value
      children = []
    },
    get children(): FakeElement[] {
      return children
    },
    append: (child: FakeElement) => children.push(child),
    listeners,
    addEventListener: (name: string, handler: () => unknown) => listeners.set(name, handler),
    setAttribute: () => {},
  } as FakeElement
  return node
}

/**
 * Every node in `root`'s subtree, `root` included — a stand-in for a real
 * DOM's recursive `textContent`, which this fake does not compute on its own.
 * @param root - the node to walk.
 * @returns `root` and all of its descendants, in document order.
 */
function subtree(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(subtree)]
}

/**
 * The concatenated, space-joined `textContent` of `root` and every
 * descendant — what a real browser's `root.textContent` would read.
 * @param root - the node to read.
 * @returns the aggregated text.
 */
function textOf(root: FakeElement): string {
  return subtree(root)
    .map((node) => node.textContent)
    .filter((text) => text !== '')
    .join(' ')
}

/** A save result or a rejection for the bridge to produce. */
type SaveOutcome = () => Promise<unknown>

/** What `settings.acceptPluginUpdate` does, keyed by test; defaults to success. */
type AcceptPluginUpdateOutcome = (pkg: string, version: string) => Promise<unknown>

/** What `settings.validatePlugin` does, keyed by test; defaults to accepting anything new. */
type ValidatePluginOutcome = (spec: string, existingPackages: string[]) => Promise<unknown>

/** The loaded renderer, plus the handles a test needs to drive and read it. */
interface Renderer {
  elements: Map<string, FakeElement>
  save(): Promise<void>
  useLatest(): Promise<void>
  /** Fires the preload's `onProgress` subscription as main would push a line. */
  pushProgress(line: string): void
  /** Fires the preload's `onUpdateAvailable` subscription as main would push a result. */
  pushUpdateAvailable(latest: string): void
  /** Fires the preload's `onPluginUpdateAvailable` subscription as main would push a result. */
  pushPluginUpdateAvailable(pkg: string, latest: string): void
  /** Types `spec` into the Add input and clicks Add. */
  addPlugin(spec: string): Promise<void>
  /** Clicks the remove control of the row naming `pkg`, or does nothing if no such row is rendered. */
  removePlugin(pkg: string): void
  /**
   * Clicks the "Use it" control of the rendered row naming `pkg`, or does
   * nothing if no such row, or no such control on it, is rendered.
   * @param pkg - the package name the row must be for.
   */
  useLatestPlugin(pkg: string): Promise<void>
  /** The rendered plugin rows' aggregated text, one entry per row, in render order. */
  renderedPluginRows(): string[]
  /** Calls made to `settings.acceptPluginUpdate`, as `[pkg, version]` pairs. */
  acceptPluginUpdateCalls: Array<[string, string]>
  /** Calls made to `settings.validatePlugin`, as `[spec, existingPackages]` pairs. */
  validatePluginCalls: Array<[string, string[]]>
}

/** Default read result: a configured local source with an empty plugin list. */
function defaultRead(): Promise<unknown> {
  return Promise.resolve({
    configured: true,
    form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
    plugins: [],
  })
}

/**
 * Load `settings.js` over a fake document.
 * @param onSave - what the `settings.save` bridge call does.
 * @param onRead - what the `settings.read` bridge call does; defaults to `defaultRead`.
 * @param onAcceptPluginUpdate - what `settings.acceptPluginUpdate` does; defaults to success.
 * @param onValidatePlugin - what `settings.validatePlugin` does; defaults to accepting any
 *   non-blank spec not already in `existingPackages`, using it verbatim as the package name.
 * @returns the fake elements and a way to drive the page.
 */
async function load(
  onSave: SaveOutcome,
  onRead?: () => Promise<unknown>,
  onAcceptPluginUpdate?: AcceptPluginUpdateOutcome,
  onValidatePlugin?: ValidatePluginOutcome,
): Promise<Renderer> {
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

  let createdCount = 0
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tagName: string) => {
      createdCount += 1
      const node = element(`__created-${tagName}-${String(createdCount)}`)
      node.tagName = tagName
      return node
    },
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
  let pluginUpdateListener: ((pkg: string, latest: string) => void) | undefined
  const acceptPluginUpdateCalls: Array<[string, string]> = []
  const validatePluginCalls: Array<[string, string[]]> = []
  const defaultValidatePlugin: ValidatePluginOutcome = async (spec, existingPackages) => {
    const trimmed = spec.trim()
    if (trimmed === '') return { ok: false, message: 'Enter a package name to add.' }
    // Mirrors `parseSpec` closely enough for a test double: a scoped
    // package's own leading `@scope/` is not a version separator.
    const searchFrom = trimmed.startsWith('@') ? 1 : 0
    const at = trimmed.indexOf('@', searchFrom)
    const pkg = at === -1 ? trimmed : trimmed.slice(0, at)
    if (existingPackages.includes(pkg)) return { ok: false, message: `${pkg} is already in the list.` }
    return { ok: true, plugin: { spec: trimmed, package: pkg, pinned: at !== -1 } }
  }
  const settings = {
    read: vi.fn(onRead ?? defaultRead),
    pickFolder: vi.fn(async () => undefined),
    save: vi.fn(onSave),
    acceptPluginUpdate: vi.fn(async (pkg: string, version: string) => {
      acceptPluginUpdateCalls.push([pkg, version])
      return (onAcceptPluginUpdate ?? (async () => ({ ok: true, warnings: [] })))(pkg, version)
    }),
    validatePlugin: vi.fn(async (spec: string, existingPackages: string[]) => {
      validatePluginCalls.push([spec, existingPackages])
      return (onValidatePlugin ?? defaultValidatePlugin)(spec, existingPackages)
    }),
    onProgress: vi.fn((listener: (line: string) => void) => {
      progressListener = listener
    }),
    onUpdateAvailable: vi.fn((listener: (latest: string) => void) => {
      updateListener = listener
    }),
    onPluginUpdateAvailable: vi.fn((listener: (pkg: string, latest: string) => void) => {
      pluginUpdateListener = listener
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

  /** The `<li>` rows rendered into `#plugin-rows`, one per configured plugin. */
  const rows = (): FakeElement[] => elements.get('plugin-rows')?.children ?? []

  /**
   * The row naming `pkg`, found by its rendered package-name text.
   * @param pkg - the package name to look for.
   * @returns the row, or undefined if none names it.
   */
  const rowFor = (pkg: string): FakeElement | undefined => rows().find((row) => textOf(row).includes(pkg))

  /**
   * The first descendant of `root` bearing `className`, or undefined.
   * @param root - the node to search.
   * @param className - the class name to match exactly.
   * @returns the matching descendant, if any.
   */
  const findByClass = (root: FakeElement, className: string): FakeElement | undefined =>
    subtree(root).find((node) => node.className === className)

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
    pushPluginUpdateAvailable: (pkg, latest) => pluginUpdateListener?.(pkg, latest),
    addPlugin: async (spec) => {
      const input = elements.get('plugin-spec')
      if (input !== undefined) input.value = spec
      await elements.get('add-plugin')?.listeners.get('click')?.()
      // The click handler is `() => void addPlugin()`: let its own promise settle.
      await Promise.resolve()
      await Promise.resolve()
    },
    removePlugin: (pkg) => {
      const row = rowFor(pkg)
      if (row === undefined) return
      findByClass(row, 'plugin-remove')?.listeners.get('click')?.()
    },
    useLatestPlugin: async (pkg) => {
      const row = rowFor(pkg)
      if (row === undefined) return
      await findByClass(row, 'plugin-update-use')?.listeners.get('click')?.()
    },
    renderedPluginRows: () => rows().map((row) => textOf(row)),
    acceptPluginUpdateCalls,
    validatePluginCalls,
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

  it('declares a row-based Add control, not a free-text plugins list', () => {
    // The bug this guards against shipping again: a `<textarea id="plugins">`
    // defers every plugin error to Save instead of rejecting it at Add.
    expect(declaredIds()).not.toContain('plugins')
    expect(declaredIds()).toEqual(expect.arrayContaining(['plugin-spec', 'add-plugin', 'plugin-rows']))
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

  it('sends the accumulated rows as one spec per line, the wire format Save still expects', async () => {
    const save = vi.fn(async (form: { plugins: string }) => {
      expect(form.plugins).toBe('@onetest/dsh-deck\n@onetest/other')
      return { ok: true, warnings: [] }
    })
    const renderer = await load(save)
    await renderer.addPlugin('@onetest/dsh-deck')
    await renderer.addPlugin('@onetest/other')
    await renderer.save()
    expect(save).toHaveBeenCalled()
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

describe('plugins', () => {
  const HOOKS = '@deepseek-ai/dsh-hooks-claude-code'
  const DECK = '@onetest/dsh-deck'

  const READ_WITH_PLUGINS = (): Promise<unknown> =>
    Promise.resolve({
      configured: true,
      form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
      plugins: [
        { spec: HOOKS, package: HOOKS, pinned: false, version: '0.1.1-rc.2' },
        { spec: `${DECK}@0.2.1`, package: DECK, pinned: true, version: undefined },
      ],
    })

  it("reports each entry's resolved version and pinned state as its own row", async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)

    const rows = renderer.renderedPluginRows()
    expect(rows).toHaveLength(2)
    expect(rows.some((row) => row.includes(HOOKS) && row.includes('v0.1.1-rc.2 installed'))).toBe(true)
    expect(rows.some((row) => row.includes(DECK) && row.includes('pinned') && row.includes('not installed yet'))).toBe(
      true,
    )
  })

  it('rows survive a reload from config, in the order the config reported them', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)
    const before = renderer.renderedPluginRows()

    // A reload — e.g. after a save — re-reads and re-renders from scratch.
    await renderer.save()

    const after = renderer.renderedPluginRows()
    expect(after).toHaveLength(before.length)
    expect(after.some((row) => row.includes(HOOKS))).toBe(true)
    expect(after.some((row) => row.includes(DECK))).toBe(true)
  })

  describe('adding a row', () => {
    it('appends a row and clears the input on a valid spec', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }))
      expect(renderer.renderedPluginRows()).toEqual([])

      await renderer.addPlugin(DECK)

      expect(renderer.renderedPluginRows()).toEqual([expect.stringContaining(DECK)])
      expect(renderer.elements.get('plugin-spec')?.value).toBe('')
      expect(renderer.elements.get('error-plugin-spec')?.textContent).toBe('')
    })

    it('validates against main, not a copy of the grammar in the renderer', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }))
      await renderer.addPlugin(DECK)
      expect(renderer.validatePluginCalls).toEqual([[DECK, []]])
    })

    it('shows an error next to the input and adds nothing on a malformed spec', async () => {
      const onValidatePlugin: ValidatePluginOutcome = async () => ({
        ok: false,
        message: '"../../etc" does not look like a package name, package@version, or a valid version.',
      })
      const renderer = await load(async () => ({ ok: true, warnings: [] }), undefined, undefined, onValidatePlugin)

      await renderer.addPlugin('../../etc')

      expect(renderer.renderedPluginRows()).toEqual([])
      expect(renderer.elements.get('error-plugin-spec')?.textContent).toContain('does not look like a package name')
    })

    it('rejects a spec naming a package already in the list, without adding a second row', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }))
      await renderer.addPlugin(DECK)

      await renderer.addPlugin(`${DECK}@0.2.1`)

      // The decision: a duplicate is refused outright, the same as at Save —
      // never silently merged or replacing the first row.
      expect(renderer.renderedPluginRows()).toHaveLength(1)
      expect(renderer.elements.get('error-plugin-spec')?.textContent).toContain('already in the list')
    })

    it('passes the currently listed packages so main can detect a duplicate', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }))
      await renderer.addPlugin(DECK)
      renderer.validatePluginCalls.length = 0

      await renderer.addPlugin(HOOKS)

      expect(renderer.validatePluginCalls).toEqual([[HOOKS, [DECK]]])
    })

    it('shows a visible error when the validate call itself rejects', async () => {
      const renderer = await load(
        async () => ({ ok: true, warnings: [] }),
        undefined,
        undefined,
        () => Promise.reject(new Error('dsh-desktop: main is unreachable')),
      )

      await renderer.addPlugin(DECK)

      expect(renderer.renderedPluginRows()).toEqual([])
      expect(renderer.elements.get('error-plugin-spec')?.textContent).toContain('main is unreachable')
    })
  })

  describe('removing a row', () => {
    it('removes exactly that entry, leaving the rest untouched', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)
      expect(renderer.renderedPluginRows()).toHaveLength(2)

      renderer.removePlugin(DECK)

      const rows = renderer.renderedPluginRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toContain(HOOKS)
      expect(rows[0]).not.toContain(DECK)
    })

    it('does nothing when no row names the package', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)

      renderer.removePlugin('@unknown/package')

      expect(renderer.renderedPluginRows()).toHaveLength(2)
    })
  })

  it('never offers an update for an entry the server never pushed one for', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)
    expect(renderer.renderedPluginRows().some((row) => row.includes('available'))).toBe(false)
  })

  it('renders the offered update inline on that row, naming the version', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)
    renderer.pushPluginUpdateAvailable(HOOKS, '0.2.0')

    const rows = renderer.renderedPluginRows()
    const hooksRow = rows.find((row) => row.includes(HOOKS))
    expect(hooksRow).toContain('0.2.0')
    expect(rows.find((row) => row.includes(DECK))).not.toContain('0.2.0')
  })

  it('an update offered for one row does not disturb the others', async () => {
    const readTwoFloating = (): Promise<unknown> =>
      Promise.resolve({
        configured: true,
        form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
        plugins: [
          { spec: HOOKS, package: HOOKS, pinned: false, version: '0.1.1-rc.2' },
          { spec: DECK, package: DECK, pinned: false, version: '0.2.0' },
        ],
      })
    const renderer = await load(async () => ({ ok: true, warnings: [] }), readTwoFloating)
    const deckRowBefore = renderer.renderedPluginRows().find((row) => row.includes(DECK))

    renderer.pushPluginUpdateAvailable(HOOKS, '0.2.1')

    const rows = renderer.renderedPluginRows()
    expect(rows.find((row) => row.includes(HOOKS))).toContain('0.2.1')
    expect(rows.find((row) => row.includes(DECK))).toBe(deckRowBefore)
  })

  it('ignores a push naming an unknown package rather than crashing', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)
    renderer.pushPluginUpdateAvailable('@unknown/package', '0.3.0')

    expect(renderer.renderedPluginRows().some((row) => row.includes('available'))).toBe(false)
  })

  describe('accepting an update', () => {
    const readOneFloating = (): Promise<unknown> =>
      Promise.resolve({
        configured: true,
        form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
        plugins: [{ spec: HOOKS, package: HOOKS, pinned: false, version: '0.1.1-rc.2' }],
      })

    it('calls acceptPluginUpdate with the package and version, never rewriting the row into a save', async () => {
      const save = vi.fn(async () => ({ ok: true, warnings: [] }))
      const renderer = await load(save, readOneFloating)
      renderer.pushPluginUpdateAvailable(HOOKS, '0.2.0')

      await renderer.useLatestPlugin(HOOKS)

      expect(renderer.acceptPluginUpdateCalls).toEqual([[HOOKS, '0.2.0']])
      expect(save).not.toHaveBeenCalled()
    })

    it('clears that row\'s hint once accepted', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }), readOneFloating)
      renderer.pushPluginUpdateAvailable(HOOKS, '0.2.0')
      expect(renderer.renderedPluginRows().some((row) => row.includes('available'))).toBe(true)

      await renderer.useLatestPlugin(HOOKS)

      expect(renderer.renderedPluginRows().some((row) => row.includes('available'))).toBe(false)
    })

    it('reports the failure and keeps the row when acceptPluginUpdate is refused', async () => {
      const renderer = await load(
        async () => ({ ok: true, warnings: [] }),
        readOneFloating,
        async () => ({ ok: false, errors: { kind: 'Port 43117 is already in use.' } }),
      )
      renderer.pushPluginUpdateAvailable(HOOKS, '0.2.0')

      await renderer.useLatestPlugin(HOOKS)

      expect(renderer.elements.get('status')?.textContent).toBe('Port 43117 is already in use.')
      expect(renderer.elements.get('status')?.classes.has('status-failed')).toBe(true)
    })
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

describe('a refused save', () => {
  it('shows the refusal beside the Save button rather than under a control it does not name', async () => {
    // `kind` rejects the whole save — a save already running, or the app
    // shutting down — so it must land where the user is looking after
    // clicking Save, not where a bad field value would.
    const renderer = await load(async () => ({
      ok: false,
      errors: { kind: 'A save is already running; wait for it to finish and try again.' },
    }))
    await renderer.save()

    const status = renderer.elements.get('status')
    expect(status?.textContent).toBe('A save is already running; wait for it to finish and try again.')
    expect(status?.classes.has('status-failed')).toBe(true)
    expect(renderer.elements.get('save')?.disabled).toBe(false)
  })

  it('never leaves a refusal reading as a successful save', async () => {
    const renderer = await load(async () => ({ ok: false, errors: { kind: 'A save is already running.' } }))
    await renderer.save()

    expect(renderer.elements.get('status')?.textContent).not.toBe('Settings saved.')
  })

  it('still routes a real field error to that field', async () => {
    const renderer = await load(async () => ({ ok: false, errors: { version: 'npm ERR! 404 Not Found' } }))
    await renderer.save()

    expect(renderer.elements.get('error-version')?.textContent).toBe('npm ERR! 404 Not Found')
    expect(renderer.elements.get('status')?.textContent).toBe('')
  })
})
