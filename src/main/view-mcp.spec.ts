import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveViewTools, VIEW_SERVER_NAME, type BrowserAutomation, type ViewDeps, type ViewServer } from './view-mcp'

let running: ViewServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/**
 * Browser automation that records calls and reports success.
 * @param overrides - the verbs a test needs to answer differently.
 * @returns the stand-in automation.
 */
function automation(overrides: Partial<BrowserAutomation> = {}): BrowserAutomation {
  return {
    readPage: vi.fn(async () => ({ ok: true, message: 'ref=1 button "Go"' }) as const),
    click: vi.fn(async () => ({ ok: true, message: 'Clicked button "Go".' }) as const),
    hover: vi.fn(async () => ({ ok: true, message: 'Hovering button.' }) as const),
    type: vi.fn(async () => ({ ok: true, message: 'Typed "Olha".' }) as const),
    press: vi.fn(async () => ({ ok: true, message: 'Pressed Enter.' }) as const),
    selectOption: vi.fn(async () => ({ ok: true, message: 'Selected "NCR".' }) as const),
    drag: vi.fn(async () => ({ ok: true, message: 'Dragged li to li.' }) as const),
    waitFor: vi.fn(async () => ({ ok: true, message: '"Saved" is there after 0.4s.' }) as const),
    takeNavigations: vi.fn(() => []),
    evaluate: vi.fn(async () => ({ ok: true, value: { rows: 3 } }) as const),
    uploadFile: vi.fn(async () => ({ ok: true, message: 'Attached.' }) as const),
    resize: vi.fn(async () => ({ ok: true, message: 'The page now measures 1600×900.' }) as const),
    screenshot: vi.fn(async () => ({ ok: true, png: 'iVBORw0K' }) as const),
    setDialogPolicy: vi.fn(),
    takeConsole: vi.fn(() => []),
    takeDialogs: vi.fn(() => []),
    ...overrides,
  }
}

/** Deps recording what the tools did. */
function deps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  return {
    browser: automation(),
    roots: () => ['/p/demo'],
    openFile: vi.fn(),
    openUrl: vi.fn(),
    showDiff: vi.fn(),
    selection: vi.fn(async () => 'selected text'),
    fetchPage: vi.fn(async (url: string) => ({ ok: true, url, title: 'A page', text: 'the content' }) as const),
    readPage: vi.fn(async () => ({ ok: true, url: 'https://example.com/', title: 'A page', text: 'the content' }) as const),
    ...overrides,
  }
}

/** Start the server on an OS-chosen port. */
async function serve(d: ViewDeps): Promise<string> {
  running = await serveViewTools(0, d)
  return `http://127.0.0.1:${String(running.port)}/mcp`
}

/**
 * Post one JSON-RPC request, as an MCP client would.
 * @param url - the server's endpoint.
 * @param body - the JSON-RPC message.
 * @returns the parsed response.
 */
async function rpc(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  // The transport answers a single request as one SSE event when the client
  // accepts that type; both forms carry the same JSON-RPC payload.
  const line = text.split('\n').find((each) => each.startsWith('data: '))
  return JSON.parse(line === undefined ? text : line.slice(6)) as Record<string, unknown>
}

/** An `initialize` message, which every MCP session opens with. */
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}

/**
 * Call one tool on a freshly initialized session.
 * @param url - the server's endpoint.
 * @param name - the tool to call.
 * @param args - its arguments.
 * @returns the tool result.
 */
async function callTool(url: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  await rpc(url, INITIALIZE)
  const answer = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  return answer.result as Record<string, unknown>
}

/** The text of a tool result. */
function textOf(result: Record<string, unknown>): string {
  return (result.content as { text: string }[]).map((part) => part.text).join('')
}

describe('the view tools server', () => {
  it('lists every view tool', async () => {
    const url = await serve(deps())
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
    expect(names.sort()).toEqual([
      'browser_click',
      'browser_console',
      'browser_drag',
      'browser_evaluate',
      'browser_handle_dialogs',
      'browser_hover',
      'browser_open',
      'browser_press_key',
      'browser_read',
      'browser_resize',
      'browser_screenshot',
      'browser_select_option',
      'browser_show',
      'browser_snapshot',
      'browser_type',
      'browser_upload_file',
      'browser_wait_for',
      'editor_open_file',
      'editor_selection',
      'editor_show_diff',
    ])
  })

  // reason: the model has a second, external browser through Playwright's own
  // MCP server, and its tools carry these same names. Every description here
  // has to say which browser it drives, or the two are indistinguishable.
  //
  // Two prefixes, and only two: `editor_` for the column beside the
  // conversation, `browser_` for the page. A third — the old `view_`, plus
  // `browse_page` and `read_open_page` standing outside both — is what had a
  // model guessing `read_page` and being told it does not exist.
  it('says in every browser tool which browser it drives', async () => {
    const url = await serve(deps())
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (answer.result as { tools: { name: string; description: string }[] }).tools ?? []
    const browserTools = tools.filter((tool) => tool.name.startsWith('browser_'))
    expect(browserTools.length).toBeGreaterThan(10)
    for (const tool of browserTools) {
      expect(tool.description, tool.name).toContain("desktop app's built-in browser")
    }
  })

  // reason: this is what the browser is for — reading the web through a real
  // browser rather than a plain fetch, with the user watching it load.
  it('reads a page it opened, title and address included', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'browser_open', { url: 'https://example.com' })
    expect(d.fetchPage).toHaveBeenCalledWith('https://example.com')
    expect(textOf(result)).toContain('A page')
    expect(textOf(result)).toContain('the content')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'not a url'])('refuses to read %s', async (target) => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'browser_open', { url: target })
    expect(d.fetchPage).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('reports why a page could not be read, rather than returning nothing', async () => {
    const d = deps({
      fetchPage: vi.fn(async () => ({ ok: false, reason: 'https://slow.example did not finish loading.' }) as const),
    })
    const url = await serve(d)
    const result = await callTool(url, 'browser_open', { url: 'https://slow.example' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('did not finish loading')
  })

  // reason: the user may have navigated there themselves, which is the point
  // of a browser they can see.
  it('reads whatever the browser is already showing', async () => {
    const d = deps()
    const url = await serve(d)
    expect(textOf(await callTool(url, 'browser_read'))).toContain('the content')
    expect(d.readPage).toHaveBeenCalled()
  })

  it('says so when the browser has nothing open', async () => {
    const d = deps({ readPage: vi.fn(async () => ({ ok: false, reason: 'The browser has no page open yet.' }) as const) })
    const url = await serve(d)
    const result = await callTool(url, 'browser_read')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no page open')
  })

  it('opens a file inside an open project', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'editor_open_file', { path: '/p/demo/src/index.ts' })
    expect(d.openFile).toHaveBeenCalledWith('/p/demo', 'src/index.ts')
    expect(textOf(result)).toContain('src/index.ts')
  })

  // reason: these arguments come from the model. A refusal that reaches it as
  // content lets it pick a different path; a protocol error does not.
  it('refuses a file outside every open project, and says so in the result', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'editor_open_file', { path: '/etc/passwd' })
    expect(d.openFile).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not inside a project')
  })

  it('opens an https page', async () => {
    const d = deps()
    const url = await serve(d)
    await callTool(url, 'browser_show', { url: 'https://example.com' })
    expect(d.openUrl).toHaveBeenCalledWith('https://example.com')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)'])('refuses to load %s', async (target) => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'browser_show', { url: target })
    expect(d.openUrl).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('shows a proposed change without writing it', async () => {
    const d = deps()
    const url = await serve(d)
    await callTool(url, 'editor_show_diff', { path: '/p/demo/readme.md', proposed: '# new' })
    expect(d.showDiff).toHaveBeenCalledWith('/p/demo', 'readme.md', '# new')
  })

  it('refuses a diff for a file outside every open project', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'editor_show_diff', { path: '/etc/hosts', proposed: 'x' })
    expect(d.showDiff).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('reports the editor selection', async () => {
    const url = await serve(deps())
    expect(textOf(await callTool(url, 'editor_selection'))).toBe('selected text')
  })

  // reason: these tools drive the window in front of the user. Nothing off
  // this machine has any business doing that.
  it('listens on loopback only', async () => {
    const d = deps()
    running = await serveViewTools(0, d)
    const port = running.port
    await expect(
      fetch(`http://127.0.0.1:${String(port)}/mcp`, { method: 'POST', body: '{}' }),
    ).resolves.toBeDefined()
    // A request to the machine's own hostname must not reach it; the connect
    // is refused rather than answered.
    await expect(fetch(`http://[::1]:${String(port)}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })

  it('answers nothing outside its own endpoint', async () => {
    running = await serveViewTools(0, deps())
    const response = await fetch(`http://127.0.0.1:${String(running.port)}/`)
    expect(response.status).toBe(404)
  })
})

describe('the browser tools', () => {
  it('numbers the page for the model to act on', async () => {
    const url = await serve(deps())
    expect(textOf(await callTool(url, 'browser_snapshot'))).toContain('ref=1 button "Go"')
  })

  it('clicks what it was told to, with the button it was told to use', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'browser_click', { target: 'ref=3', button: 'right', count: 2 })
    expect(browser.click).toHaveBeenCalledWith('ref=3', { button: 'right', count: 2 })
    expect(textOf(result)).toBe('Clicked button "Go".')
  })

  it('clears a field by default when typing into it', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_type', { target: '#firstName', text: 'Olha' })
    expect(browser.type).toHaveBeenCalledWith('#firstName', 'Olha', true)
    await callTool(url, 'browser_type', { target: '#firstName', text: 'Olha', clear: false })
    expect(browser.type).toHaveBeenLastCalledWith('#firstName', 'Olha', false)
  })

  it('presses a key', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_press_key', { key: 'Enter' })
    expect(browser.press).toHaveBeenCalledWith('Enter')
  })

  it('drags one element onto another', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_drag', { from: 'text=One', to: 'text=Six' })
    expect(browser.drag).toHaveBeenCalledWith('text=One', 'text=Six', { dx: 0, dy: 0 })
  })

  // reason: a resize handle is dragged by a distance, and the nearest element
  // to that distance is not the same thing.
  it('drags by a distance when given one', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_drag', { from: '.handle', dx: 50, dy: 30 })
    expect(browser.drag).toHaveBeenCalledWith('.handle', undefined, { dx: 50, dy: 30 })
  })

  it('waits for the time to pass when nothing in particular is named', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_wait_for', { seconds: 6 })
    expect(browser.waitFor).toHaveBeenCalledWith(undefined, undefined, false, 6)
  })

  it('waits for something to appear, and for something to go', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_wait_for', { text: 'Saved' })
    expect(browser.waitFor).toHaveBeenCalledWith(undefined, 'Saved', false, 10)
    await callTool(url, 'browser_wait_for', { target: '#spinner', gone: true, seconds: 30 })
    expect(browser.waitFor).toHaveBeenLastCalledWith('#spinner', undefined, true, 30)
  })

  // reason: a page that navigates under an automation run loses everything
  // typed into it, and a run that is not told cannot tell that from a step
  // that simply failed.
  it('reports a page the browser moved to on its own', async () => {
    const browser = automation({ takeNavigations: vi.fn(() => [{ url: 'https://demoqa.com/alerts' }]) })
    const url = await serve(deps({ browser }))
    const text = textOf(await callTool(url, 'browser_type', { target: '#firstName', text: 'Olha' }))
    expect(text).toContain('The browser moved to https://demoqa.com/alerts.')
  })

  it('returns what an expression evaluated to, as JSON', async () => {
    const url = await serve(deps())
    expect(textOf(await callTool(url, 'browser_evaluate', { expression: 'x' }))).toBe('{\n  "rows": 3\n}')
  })

  it('reports an expression the page refused, as an error', async () => {
    const browser = automation({ evaluate: vi.fn(async () => ({ ok: false, reason: 'TypeError: nope' }) as const) })
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'browser_evaluate', { expression: 'boom()' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('TypeError: nope')
  })

  // reason: the path is model-supplied and names a file to hand to a web
  // page, which is the one argument here that leaves the machine.
  it('refuses to attach a file outside a project the user has open', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'browser_upload_file', { target: '#uploadPicture', path: '/etc/passwd' })
    expect(result.isError).toBe(true)
    expect(browser.uploadFile).not.toHaveBeenCalled()
  })

  it('attaches a file inside one', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_upload_file', { target: '#uploadPicture', path: '/p/demo/shot.png' })
    expect(browser.uploadFile).toHaveBeenCalledWith('#uploadPicture', '/p/demo/shot.png')
  })

  it('sets a standing dialog policy', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_handle_dialogs', { action: 'accept', prompt_text: 'Olha' })
    expect(browser.setDialogPolicy).toHaveBeenCalledWith({ accept: true, promptText: 'Olha' })
  })

  // reason: a dialog is answered the instant it opens, so the action that
  // caused it is the only place it can be reported.
  it('reports a dialog alongside the action that opened it', async () => {
    const browser = automation({
      takeDialogs: vi.fn(() => [{ kind: 'confirm', message: 'Do you confirm action?', accepted: true }]),
    })
    const url = await serve(deps({ browser }))
    const text = textOf(await callTool(url, 'browser_click', { target: '#confirmButton' }))
    expect(text).toContain('Clicked button "Go".')
    expect(text).toContain('A confirm said "Do you confirm action?" and was accepted.')
  })

  it('reports a dialog on a failed action too', async () => {
    const browser = automation({
      click: vi.fn(async () => ({ ok: false, reason: '#x: no element matches' }) as const),
      takeDialogs: vi.fn(() => [{ kind: 'alert', message: 'hi', accepted: false }]),
    })
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'browser_click', { target: '#x' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('was dismissed')
  })

  it('reads the console, and says so when there is nothing in it', async () => {
    const url = await serve(deps())
    expect(textOf(await callTool(url, 'browser_console'))).toContain('Nothing has been logged')
  })

  it('reads console entries with their level', async () => {
    const browser = automation({
      takeConsole: vi.fn(() => [{ level: 'error', text: 'TypeError: Lr.findDOMNode is not a function' }]),
    })
    const url = await serve(deps({ browser }))
    expect(textOf(await callTool(url, 'browser_console'))).toBe(
      '[error] TypeError: Lr.findDOMNode is not a function',
    )
  })

  it('sets the viewport a layout needs', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'browser_resize', { width: 1600, height: 900 })
    expect(browser.resize).toHaveBeenCalledWith(1600, 900)
  })

  it('returns a screenshot as an image, not as text', async () => {
    const url = await serve(deps())
    const result = await callTool(url, 'browser_screenshot')
    expect(result.content).toEqual([{ type: 'image', data: 'iVBORw0K', mimeType: 'image/png' }])
  })

  it('reports a screenshot that could not be taken', async () => {
    const browser = automation({ screenshot: vi.fn(async () => ({ ok: false, reason: 'no target' }) as const) })
    const url = await serve(deps({ browser }))
    expect((await callTool(url, 'browser_screenshot')).isError).toBe(true)
  })
})

// reason: the harness publishes each tool as `mcp__<server>__<tool>` and
// allows a hyphen there, so a hyphenated server name produced a tool name
// mixing both separators — which a model normalizes to underscores, calls,
// and is told is unknown. Observed against a real session.
describe('the server name the harness namespaces tools with', () => {
  it('uses one separator, so there is nothing to normalize', () => {
    expect(VIEW_SERVER_NAME).toBe('desktop_views')
    expect(VIEW_SERVER_NAME).not.toContain('-')
  })

  it('is a name the harness will publish verbatim', () => {
    // The harness's own contract: `[A-Za-z0-9_-]`, and the joined name within
    // 64 characters, or it is hashed and no longer predictable.
    const longest = `mcp__${VIEW_SERVER_NAME}__browser_select_option`
    expect(longest).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(longest.length).toBeLessThanOrEqual(64)
  })
})

describe('the shape of the tool surface', () => {
  /**
   * Every tool this server publishes.
   * @param url - the server's endpoint.
   * @returns their names.
   */
  async function names(url: string): Promise<string[]> {
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    return ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
  }

  // reason: a model reads the list and guesses the rest. Names that share a
  // prefix per surface are guessable; three prefixes for two surfaces are not.
  it('groups every tool under one of two prefixes', async () => {
    const url = await serve(deps())
    for (const name of await names(url)) {
      expect(name, name).toMatch(/^(editor|browser)_/)
    }
  })

  // reason: `browse_page`, `read_open_page` and `browser_read_page` were three
  // names for three nearby things, close enough that a model reached for one
  // that did not exist. Each of the three now says what it gives back.
  it('names the three ways of getting at a page distinctly', async () => {
    const url = await serve(deps())
    const published = await names(url)
    expect(published).toContain('browser_open')
    expect(published).toContain('browser_read')
    expect(published).toContain('browser_snapshot')
    expect(published).not.toContain('browser_read_page')
    expect(published).not.toContain('read_open_page')
  })

  // reason: past 64 characters the harness hashes the published name, and a
  // hashed name is not one a model can predict from the others.
  it('publishes every name verbatim under the harness contract', async () => {
    const url = await serve(deps())
    for (const name of await names(url)) {
      const published = `mcp__desktop_views__${name}`
      expect(published, published).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(published.length, published).toBeLessThanOrEqual(64)
    }
  })
})
