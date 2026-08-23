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
 * The `aria-selected` value each tag declares in the markup itself, so the
 * fixture's initial state matches what a real DOM parse would give before
 * any script runs.
 * @returns each id's declared `aria-selected` value, for tags that declare one.
 */
function declaredAriaSelected(): Map<string, string> {
  const values = new Map<string, string>()
  for (const match of MARKUP.matchAll(/<[a-z]+\b[^>]*>/g)) {
    const tag = match[0]
    const id = /\bid="([^"]+)"/.exec(tag)?.[1]
    const selected = /\baria-selected="([^"]+)"/.exec(tag)?.[1]
    if (id !== undefined && selected !== undefined) values.set(id, selected)
  }
  return values
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
  tabIndex: number
  classes: Set<string>
  classList: { add(name: string): void; remove(name: string): void }
  children: FakeElement[]
  append(child: FakeElement): void
  addEventListener(name: string, handler: (event?: unknown) => unknown): void
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  attributes: Map<string, string>
  listeners: Map<string, (event?: unknown) => unknown>
  focus(): void
  focused: boolean
}

function element(id: string): FakeElement {
  const classes = new Set<string>()
  const listeners = new Map<string, (event?: unknown) => unknown>()
  const attributes = new Map<string, string>()
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
    tabIndex: 0,
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
    addEventListener: (name: string, handler: (event?: unknown) => unknown) => listeners.set(name, handler),
    attributes,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    focused: false,
    focus() {
      this.focused = true
    },
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

/** What `settings.checkBinaries` does, keyed by test; defaults to both binaries succeeding. */
type CheckBinariesOutcome = (pnpmPath: string, npmPath: string) => Promise<unknown>

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
  /** Calls made to `settings.checkBinaries`, as `[pnpmPath, npmPath]` pairs. */
  checkBinariesCalls: Array<[string, string]>
  /** Clicks the Check button and awaits its own async handler. */
  checkBinaries(): Promise<void>
  /** Clicks the tab button for `id`. */
  clickTab(id: string): void
  /**
   * Fires a `keydown` for `key` on the tab button for `id`, as a real key
   * press would.
   * @returns whether the handler called `event.preventDefault()`.
   */
  pressTabKey(id: string, key: string): boolean
  /** The tab id whose button reports `aria-selected="true"`. */
  activeTab(): string | undefined
  /** Whether the panel for `id` is hidden. */
  panelHidden(id: string): boolean | undefined
  /** The tab button's roving `tabIndex` for `id`. */
  tabTabIndex(id: string): number | undefined
  /** Whether the error dot on the tab button for `id` is showing. */
  tabErrorDotVisible(id: string): boolean | undefined
  /** Fires the Add button's click listener without awaiting it, as two fast real clicks would. */
  clickAddRaw(): void
  /** How many times `settings.read` has been called so far (the initial load, plus one per reload). */
  readCallCount(): number
}

/** The tab ids declared in `settings.html`'s tab bar, in document order. */
function declaredTabIds(): string[] {
  return [...MARKUP.matchAll(/\bid="tab-([a-z]+)"/g)].map((match) => match[1])
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
 * @param onCheckBinaries - what `settings.checkBinaries` does; defaults to both binaries
 *   reporting success with a fixed version string.
 * @returns the fake elements and a way to drive the page.
 */
async function load(
  onSave: SaveOutcome,
  onRead?: () => Promise<unknown>,
  onAcceptPluginUpdate?: AcceptPluginUpdateOutcome,
  onValidatePlugin?: ValidatePluginOutcome,
  onCheckBinaries?: CheckBinariesOutcome,
): Promise<Renderer> {
  const hiddenIds = declaredHiddenIds()
  const ariaSelected = declaredAriaSelected()
  const elements = new Map(
    declaredIds().map((id) => {
      const node = element(id)
      node.hidden = hiddenIds.has(id)
      const selected = ariaSelected.get(id)
      if (selected !== undefined) node.setAttribute('aria-selected', selected)
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
  const checkBinariesCalls: Array<[string, string]> = []
  const defaultCheckBinaries: CheckBinariesOutcome = async () => ({
    pnpm: { ok: true, version: '9.1.0' },
    npm: { ok: true, version: '10.2.0' },
  })
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
      return (onAcceptPluginUpdate ?? (async (_pkg, acceptedVersion) => ({ ok: true, warnings: [], version: acceptedVersion })))(
        pkg,
        version,
      )
    }),
    validatePlugin: vi.fn(async (spec: string, existingPackages: string[]) => {
      validatePluginCalls.push([spec, existingPackages])
      return (onValidatePlugin ?? defaultValidatePlugin)(spec, existingPackages)
    }),
    checkBinaries: vi.fn(async (pnpmPath: string, npmPath: string) => {
      checkBinariesCalls.push([pnpmPath, npmPath])
      return (onCheckBinaries ?? defaultCheckBinaries)(pnpmPath, npmPath)
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
    clickTab: (id) => {
      elements.get(`tab-${id}`)?.listeners.get('click')?.()
    },
    pressTabKey: (id, key) => {
      let prevented = false
      elements.get(`tab-${id}`)?.listeners.get('keydown')?.({
        key,
        preventDefault: () => {
          prevented = true
        },
      })
      return prevented
    },
    activeTab: () => declaredTabIds().find((id) => elements.get(`tab-${id}`)?.getAttribute('aria-selected') === 'true'),
    panelHidden: (id) => elements.get(`panel-${id}`)?.hidden,
    tabTabIndex: (id) => elements.get(`tab-${id}`)?.tabIndex,
    tabErrorDotVisible: (id) => {
      const hidden = elements.get(`tab-${id}-error-dot`)?.hidden
      return hidden === undefined ? undefined : !hidden
    },
    clickAddRaw: () => {
      elements.get('add-plugin')?.listeners.get('click')?.()
    },
    readCallCount: () => settings.read.mock.calls.length,
    checkBinariesCalls,
    checkBinaries: async () => {
      elements.get('check-binaries')?.listeners.get('click')?.()
      // The click handler is `() => void checkBinaries()`: let its own promise settle.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
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
    const readsBefore = renderer.readCallCount()

    // A successful save re-reads and re-renders from scratch, so the resolved
    // versions it just installed reach the rows on screen (see `performSave`).
    // Asserting the read count actually grew is what makes this test prove a
    // reload happened, rather than only being consistent with one never
    // happening at all.
    await renderer.save()

    expect(renderer.readCallCount()).toBeGreaterThan(readsBefore)
    const after = renderer.renderedPluginRows()
    expect(after).toHaveLength(before.length)
    expect(after.some((row) => row.includes(HOOKS))).toBe(true)
    expect(after.some((row) => row.includes(DECK))).toBe(true)
  })

  it('a row added this session shows its resolved version once the save that installed it succeeds', async () => {
    // The read the initial `load()` uses, and the read `performSave` triggers
    // after a successful save, are different responses: the second reports
    // the version the save just installed, which is what the row must show
    // afterward instead of still reading "not installed yet".
    const onRead = vi
      .fn()
      .mockResolvedValueOnce({
        configured: true,
        form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
        plugins: [],
      })
      .mockResolvedValue({
        configured: true,
        form: Object.fromEntries([['kind', 'local'], ...FIELDS.map((name) => [name, ''])]),
        plugins: [{ spec: DECK, package: DECK, pinned: false, version: '0.2.0' }],
      })
    const renderer = await load(async () => ({ ok: true, warnings: [] }), onRead)
    await renderer.addPlugin(DECK)
    expect(renderer.renderedPluginRows()).toEqual([expect.stringContaining('not installed yet')])

    await renderer.save()

    expect(renderer.renderedPluginRows()).toEqual([expect.stringContaining('v0.2.0 installed')])
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

    it('guards a second Add firing before the first settles, adding only one row', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }))
      const input = renderer.elements.get('plugin-spec')
      if (input !== undefined) input.value = DECK

      // Two synchronous clicks, the way two fast real clicks land before
      // either's `await validatePlugin(...)` has a chance to resolve.
      renderer.clickAddRaw()
      renderer.clickAddRaw()
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve()

      expect(renderer.renderedPluginRows()).toHaveLength(1)
      expect(renderer.validatePluginCalls).toHaveLength(1)
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

  it('survives an unrelated save: a save that never touches this plugin keeps its update hint', async () => {
    // `onPluginUpdateAvailable` pushes at most once per `read`, so a hint this
    // dropped would be unreachable until Settings is reopened — exactly what
    // the shared `pluginUpdates` map's own comment says it exists to prevent.
    const renderer = await load(async () => ({ ok: true, warnings: [] }), READ_WITH_PLUGINS)
    renderer.pushPluginUpdateAvailable(HOOKS, '0.2.0')
    expect(renderer.renderedPluginRows().find((row) => row.includes(HOOKS))).toContain('available')

    // Saves something unrelated to plugins (the hotkey field is already blank
    // in the loaded form; this save simply re-submits it).
    await renderer.save()

    expect(renderer.renderedPluginRows().find((row) => row.includes(HOOKS))).toContain('available')
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

    it('updates the accepted row to the version just installed, in place', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }), readOneFloating)
      renderer.pushPluginUpdateAvailable(HOOKS, '0.2.0')

      await renderer.useLatestPlugin(HOOKS)

      expect(renderer.renderedPluginRows()).toEqual([expect.stringContaining('v0.2.0 installed')])
    })

    it('never re-reads config: only the accepted row changes, so a row added but not yet saved survives', async () => {
      const renderer = await load(async () => ({ ok: true, warnings: [] }), readOneFloating)
      const readsBefore = renderer.readCallCount()
      await renderer.addPlugin(DECK)
      renderer.pushPluginUpdateAvailable(HOOKS, '0.2.0')

      await renderer.useLatestPlugin(HOOKS)

      // `readCallCount` unchanged proves this took the in-place update path,
      // not a `load()` that happens to keep the unsaved row for some other
      // reason — the vacuity check (see docs/notes/settings-tabs.md) confirms
      // the row disappears when that path is reverted to a `load()`.
      expect(renderer.readCallCount()).toBe(readsBefore)
      const rows = renderer.renderedPluginRows()
      expect(rows).toHaveLength(2)
      expect(rows.some((row) => row.includes(DECK) && row.includes('not installed yet'))).toBe(true)
      expect(rows.find((row) => row.includes(HOOKS))).toContain('v0.2.0 installed')
    })
  })

  describe('gated while a save is in flight', () => {
    /**
     * A `save` bridge call that never resolves on its own, so a test can
     * drive Save into its in-flight state, probe it, and only then let it
     * finish by calling the returned resolver.
     * @returns the bridge function to pass as `onSave`, and a function that
     *   resolves the save it produced.
     */
    function deferredSave(): {
      save: SaveOutcome
      resolve: (outcome: { ok: true; warnings: string[] }) => void
    } {
      let resolve: (outcome: { ok: true; warnings: string[] }) => void = () => {
        throw new Error('resolve called before save() was invoked')
      }
      const save: SaveOutcome = () =>
        new Promise((res) => {
          resolve = res as (outcome: { ok: true; warnings: string[] }) => void
        })
      return { save, resolve: (outcome) => resolve(outcome) }
    }

    it('an Add attempted mid-save is refused, not silently lost once the save reloads the list', async () => {
      const { save, resolve } = deferredSave()
      const renderer = await load(save)

      const savePromise = renderer.save()
      // Let `performSave` run up to its own `await window.settings.save(...)`.
      await Promise.resolve()
      await Promise.resolve()
      expect(renderer.elements.get('add-plugin')?.disabled).toBe(true)

      await renderer.addPlugin(DECK)
      expect(renderer.renderedPluginRows()).toEqual([])
      expect(renderer.validatePluginCalls).toEqual([])

      resolve({ ok: true, warnings: [] })
      await savePromise

      // Add works normally again once the save has finished, and nothing
      // from the refused attempt was silently kept either.
      expect(renderer.elements.get('add-plugin')?.disabled).toBe(false)
      expect(renderer.renderedPluginRows()).toEqual([])
      await renderer.addPlugin(DECK)
      expect(renderer.renderedPluginRows()).toEqual([expect.stringContaining(DECK)])
    })

    it('a Remove attempted mid-save is refused, not silently undone once the save reloads the list', async () => {
      const { save, resolve } = deferredSave()
      const renderer = await load(save, READ_WITH_PLUGINS)
      expect(renderer.renderedPluginRows()).toHaveLength(2)

      const savePromise = renderer.save()
      await Promise.resolve()
      await Promise.resolve()

      renderer.removePlugin(DECK)
      // Refused outright: the row is still there, not silently queued.
      expect(renderer.renderedPluginRows()).toHaveLength(2)

      resolve({ ok: true, warnings: [] })
      await savePromise

      // The reload re-reads the same two entries `READ_WITH_PLUGINS` always
      // reports; DECK's row surviving here is not "the reload happened to
      // keep it" — the point is that Remove was never allowed to touch it
      // while the save was in flight, so there was nothing to lose.
      const rows = renderer.renderedPluginRows()
      expect(rows).toHaveLength(2)
      expect(rows.some((row) => row.includes(DECK))).toBe(true)
      expect(rows.some((row) => row.includes(HOOKS))).toBe(true)
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

describe('tabs', () => {
  it('declares real tab semantics: role, aria-selected, and tabpanels', () => {
    expect(MARKUP).toMatch(/role="tablist"/)
    expect((MARKUP.match(/role="tab"/g) ?? []).length).toBe(4)
    expect((MARKUP.match(/role="tabpanel"/g) ?? []).length).toBe(4)
    expect(declaredTabIds()).toEqual(['harness', 'plugins', 'notifications', 'advanced'])
  })

  it('starts on the harness tab, with the rest hidden', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    expect(renderer.activeTab()).toBe('harness')
    expect(renderer.panelHidden('harness')).toBe(false)
    expect(renderer.panelHidden('plugins')).toBe(true)
    expect(renderer.panelHidden('notifications')).toBe(true)
    expect(renderer.panelHidden('advanced')).toBe(true)
  })

  it('clicking a tab shows its panel and hides the others', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))

    renderer.clickTab('plugins')

    expect(renderer.activeTab()).toBe('plugins')
    expect(renderer.panelHidden('plugins')).toBe(false)
    expect(renderer.panelHidden('harness')).toBe(true)
    expect(renderer.panelHidden('notifications')).toBe(true)
    expect(renderer.panelHidden('advanced')).toBe(true)
  })

  it('moves the roving tabIndex to the selected tab', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))

    renderer.clickTab('advanced')

    expect(renderer.tabTabIndex('advanced')).toBe(0)
    expect(renderer.tabTabIndex('harness')).toBe(-1)
    expect(renderer.tabTabIndex('plugins')).toBe(-1)
    expect(renderer.tabTabIndex('notifications')).toBe(-1)
  })

  it('ArrowRight/ArrowLeft move between tabs, wrapping at the ends, and suppress the default action', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))

    expect(renderer.pressTabKey('harness', 'ArrowRight')).toBe(true)
    expect(renderer.activeTab()).toBe('plugins')

    expect(renderer.pressTabKey('plugins', 'ArrowLeft')).toBe(true)
    expect(renderer.activeTab()).toBe('harness')

    expect(renderer.pressTabKey('harness', 'ArrowLeft')).toBe(true)
    expect(renderer.activeTab()).toBe('advanced')
  })

  it('Home and End jump to the first and last tab, and suppress the default action', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))

    expect(renderer.pressTabKey('harness', 'End')).toBe(true)
    expect(renderer.activeTab()).toBe('advanced')

    expect(renderer.pressTabKey('advanced', 'Home')).toBe(true)
    expect(renderer.activeTab()).toBe('harness')
  })

  it('leaves an unrelated key alone: no tab change, no default action suppressed', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))

    expect(renderer.pressTabKey('harness', 'a')).toBe(false)
    expect(renderer.activeTab()).toBe('harness')
  })

  it('a validation error on a field in an inactive tab switches to that tab and marks it', async () => {
    const renderer = await load(async () => ({ ok: false, errors: { hotkey: 'A shortcut is required.' } }))
    expect(renderer.activeTab()).toBe('harness')

    await renderer.save()

    expect(renderer.activeTab()).toBe('notifications')
    expect(renderer.panelHidden('notifications')).toBe(false)
    expect(renderer.elements.get('error-hotkey')?.textContent).toBe('A shortcut is required.')
    expect(renderer.tabErrorDotVisible('notifications')).toBe(true)
  })

  it('does not switch tabs when the erroring field is already on the active tab', async () => {
    const renderer = await load(async () => ({ ok: false, errors: { repo: 'That path is not a folder.' } }))

    await renderer.save()

    expect(renderer.activeTab()).toBe('harness')
    expect(renderer.elements.get('error-repo')?.textContent).toBe('That path is not a folder.')
  })

  it('a fresh save clears a stale error dot from a previous attempt', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errors: { hotkey: 'A shortcut is required.' } })
      .mockResolvedValueOnce({ ok: true, warnings: [] })
    const renderer = await load(save)

    await renderer.save()
    expect(renderer.tabErrorDotVisible('notifications')).toBe(true)

    renderer.clickTab('harness')
    await renderer.save()
    expect(renderer.tabErrorDotVisible('notifications')).toBe(false)
  })

  it('an accumulated-list plugins error routes to the Plugins tab, its own error node, and a dot', async () => {
    const renderer = await load(async () => ({ ok: false, errors: { plugins: '@x/y is listed more than once.' } }))
    expect(renderer.activeTab()).toBe('harness')

    await renderer.save()

    expect(renderer.activeTab()).toBe('plugins')
    expect(renderer.panelHidden('plugins')).toBe(false)
    expect(renderer.elements.get('error-plugins')?.textContent).toBe('@x/y is listed more than once.')
    expect(renderer.tabErrorDotVisible('plugins')).toBe(true)
  })

  it('a rejected key with no error node of its own still reaches the user, on the status line', async () => {
    // No field named `mysteryField` exists in the form today; this proves the
    // fallback for *any* key Save might one day reject without a dedicated
    // node — the failure mode HIGH 1 was: no text, no dot, no tab switch, and
    // a blank status that reads exactly like a successful save.
    const renderer = await load(async () => ({
      ok: false,
      errors: { mysteryField: 'Something about mysteryField is wrong.' },
    }))

    await renderer.save()

    const status = renderer.elements.get('status')
    expect(status?.textContent).toContain('Something about mysteryField is wrong.')
    expect(status?.classes.has('status-failed')).toBe(true)
    // No tab claims this field, so nothing should have moved.
    expect(renderer.activeTab()).toBe('harness')
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

describe('checking pnpm/npm paths', () => {
  it('reports success for both binaries with their printed versions', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    const pnpmInput = renderer.elements.get('pnpmPath')
    const npmInput = renderer.elements.get('npmPath')
    if (pnpmInput !== undefined) pnpmInput.value = '/opt/pnpm'
    if (npmInput !== undefined) npmInput.value = '/opt/npm'

    await renderer.checkBinaries()

    expect(renderer.checkBinariesCalls).toEqual([['/opt/pnpm', '/opt/npm']])
    expect(renderer.elements.get('check-result-pnpm')?.textContent).toBe('OK — 9.1.0')
    expect(renderer.elements.get('check-result-pnpm')?.classes.has('check-result-ok')).toBe(true)
    expect(renderer.elements.get('check-result-npm')?.textContent).toBe('OK — 10.2.0')
    expect(renderer.elements.get('check-result-npm')?.classes.has('check-result-ok')).toBe(true)
  })

  it('shows the real failure for one binary while the other still reports success', async () => {
    const renderer = await load(
      async () => ({ ok: true, warnings: [] }),
      undefined,
      undefined,
      undefined,
      async () => ({
        pnpm: { ok: false, error: 'pnpm: command not found' },
        npm: { ok: true, version: '10.2.0' },
      }),
    )

    await renderer.checkBinaries()

    const pnpmResult = renderer.elements.get('check-result-pnpm')
    expect(pnpmResult?.textContent).toBe('pnpm: command not found')
    expect(pnpmResult?.classes.has('check-result-failed')).toBe(true)
    expect(pnpmResult?.classes.has('check-result-ok')).toBe(false)

    const npmResult = renderer.elements.get('check-result-npm')
    expect(npmResult?.textContent).toBe('OK — 10.2.0')
    expect(npmResult?.classes.has('check-result-ok')).toBe(true)
  })

  it('checks a blank field via PATH rather than skipping it', async () => {
    const renderer = await load(async () => ({ ok: true, warnings: [] }))
    const pnpmInput = renderer.elements.get('pnpmPath')
    if (pnpmInput !== undefined) pnpmInput.value = ''

    await renderer.checkBinaries()

    expect(renderer.checkBinariesCalls).toEqual([['', '']])
    expect(renderer.elements.get('check-result-pnpm')?.textContent).toBe('OK — 9.1.0')
  })

  it('disables the button while the check runs and re-enables it once done', async () => {
    let resolveCheck: (() => void) | undefined
    const renderer = await load(
      async () => ({ ok: true, warnings: [] }),
      undefined,
      undefined,
      undefined,
      () =>
        new Promise((resolve) => {
          resolveCheck = () =>
            resolve({ pnpm: { ok: true, version: '9.1.0' }, npm: { ok: true, version: '10.2.0' } })
        }),
    )

    const clickPromise = renderer.checkBinaries()
    expect(renderer.elements.get('check-binaries')?.disabled).toBe(true)
    resolveCheck?.()
    await clickPromise

    expect(renderer.elements.get('check-binaries')?.disabled).toBe(false)
  })

  it('does not touch Save or write anything itself', async () => {
    const save = vi.fn(async () => ({ ok: true, warnings: [] }))
    const renderer = await load(save)

    await renderer.checkBinaries()

    expect(save).not.toHaveBeenCalled()
  })
})
