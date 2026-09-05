import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveViewTools, SURFACES, type BrowserAutomation, type ViewDeps, type ViewServer } from './view-mcp'

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
    project: () => undefined,
    openFile: vi.fn(),
    openUrl: vi.fn(),
    showDiff: vi.fn(),
    selection: vi.fn(async () => 'selected text'),
    fetchPage: vi.fn(async (url: string) => ({ ok: true, url, title: 'A page', text: 'the content' }) as const),
    readPage: vi.fn(async () => ({ ok: true, url: 'https://example.com/', title: 'A page', text: 'the content' }) as const),
    ...overrides,
  }
}

/**
 * Start the server on an OS-chosen port.
 * @param d - what the tools act on.
 * @param surface - which surface's endpoint to address; the browser's by
 *   default, since most tools live there.
 * @returns that surface's endpoint.
 */
async function serve(d: ViewDeps, surface: keyof typeof SURFACES = 'browser'): Promise<string> {
  running = await serveViewTools(0, d)
  return `http://127.0.0.1:${String(running.port)}${SURFACES[surface].path}`
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

/**
 * A project directory holding a board with the files given.
 *
 * Real directories rather than a mocked filesystem: the board's whole contract
 * is what is on disk, and a test over a fake one would prove nothing about it.
 * @param files - paths within `.dsh/tasks/`, mapped to their contents.
 * @returns the project's root directory.
 */
function boardFixture(files: Record<string, string>): string {
  // tmpdir() sits under a symlink (/var -> /private/var), and resolveInBoard
  // compares the realpath of an existing target against the project root — a
  // path about to be created (createEntity's own target) is not yet realpath-
  // able, so the project root must already be canonical. See board-paths.spec.ts.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mcp-board-')))
  mkdirSync(join(project, '.dsh', 'tasks'), { recursive: true })
  for (const [path, body] of Object.entries(files)) {
    const full = join(project, '.dsh', 'tasks', path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return project
}

describe('the view tools server', () => {
  it('lists the browser\u2019s tools on the browser\u2019s endpoint', async () => {
    const url = await serve(deps())
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
    expect(names.sort()).toEqual([
      'click',
      'console',
      'drag',
      'drag_cancel',
      'drag_drop',
      'drag_move',
      'drag_start',
      'evaluate',
      'handle_dialogs',
      'hover',
      'open',
      'press_key',
      'read',
      'resize',
      'screenshot',
      'select_option',
      'show',
      'snapshot',
      'type',
      'upload_file',
      'wait_for',
    ])
  })

  it('lists the editor\u2019s tools on the editor\u2019s endpoint, and only those', async () => {
    const url = await serve(deps(), 'editor')
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
    expect(names.sort()).toEqual([
      'board_create',
      'board_criterion',
      'board_delete',
      'board_link',
      'board_read',
      'board_run',
      'board_status',
      'board_update',
      'open_file',
      'selection',
      'show_diff',
    ])
  })

  it('answers nothing on a path no surface claims', async () => {
    const url = await serve(deps())
    const response = await fetch(url.replace('/browser', '/mcp'), { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
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
    expect(tools.length).toBeGreaterThan(10)
    for (const tool of tools) {
      expect(tool.description, tool.name).toContain("desktop app's built-in browser")
    }
  })

  // reason: this is what the browser is for — reading the web through a real
  // browser rather than a plain fetch, with the user watching it load.
  it('reads a page it opened, title and address included', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'open', { url: 'https://example.com' })
    expect(d.fetchPage).toHaveBeenCalledWith('https://example.com')
    expect(textOf(result)).toContain('A page')
    expect(textOf(result)).toContain('the content')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'not a url'])('refuses to read %s', async (target) => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'open', { url: target })
    expect(d.fetchPage).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('reports why a page could not be read, rather than returning nothing', async () => {
    const d = deps({
      fetchPage: vi.fn(async () => ({ ok: false, reason: 'https://slow.example did not finish loading.' }) as const),
    })
    const url = await serve(d)
    const result = await callTool(url, 'open', { url: 'https://slow.example' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('did not finish loading')
  })

  // reason: the user may have navigated there themselves, which is the point
  // of a browser they can see.
  it('reads whatever the browser is already showing', async () => {
    const d = deps()
    const url = await serve(d)
    expect(textOf(await callTool(url, 'read'))).toContain('the content')
    expect(d.readPage).toHaveBeenCalled()
  })

  it('says so when the browser has nothing open', async () => {
    const d = deps({ readPage: vi.fn(async () => ({ ok: false, reason: 'The browser has no page open yet.' }) as const) })
    const url = await serve(d)
    const result = await callTool(url, 'read')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no page open')
  })

  it('opens a file inside an open project', async () => {
    const d = deps()
    const url = await serve(d, 'editor')
    const result = await callTool(url, 'open_file', { path: '/p/demo/src/index.ts' })
    expect(d.openFile).toHaveBeenCalledWith('/p/demo', 'src/index.ts')
    expect(textOf(result)).toContain('src/index.ts')
  })

  // reason: these arguments come from the model. A refusal that reaches it as
  // content lets it pick a different path; a protocol error does not.
  it('refuses a file outside every open project, and says so in the result', async () => {
    const d = deps()
    const url = await serve(d, 'editor')
    const result = await callTool(url, 'open_file', { path: '/etc/passwd' })
    expect(d.openFile).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not inside a project')
  })

  it('opens an https page', async () => {
    const d = deps()
    const url = await serve(d)
    await callTool(url, 'show', { url: 'https://example.com' })
    expect(d.openUrl).toHaveBeenCalledWith('https://example.com')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)'])('refuses to load %s', async (target) => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'show', { url: target })
    expect(d.openUrl).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('shows a proposed change without writing it', async () => {
    const d = deps()
    const url = await serve(d, 'editor')
    await callTool(url, 'show_diff', { path: '/p/demo/readme.md', proposed: '# new' })
    expect(d.showDiff).toHaveBeenCalledWith('/p/demo', 'readme.md', '# new')
  })

  it('refuses a diff for a file outside every open project', async () => {
    const d = deps()
    const url = await serve(d, 'editor')
    const result = await callTool(url, 'show_diff', { path: '/etc/hosts', proposed: 'x' })
    expect(d.showDiff).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('reports the editor selection', async () => {
    const url = await serve(deps(), 'editor')
    expect(textOf(await callTool(url, 'selection'))).toBe('selected text')
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
    expect(textOf(await callTool(url, 'snapshot'))).toContain('ref=1 button "Go"')
  })

  it('clicks what it was told to, with the button it was told to use', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'click', { target: 'ref=3', button: 'right', count: 2 })
    expect(browser.click).toHaveBeenCalledWith('ref=3', { button: 'right', count: 2 })
    expect(textOf(result)).toBe('Clicked button "Go".')
  })

  it('clears a field by default when typing into it', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'type', { target: '#firstName', text: 'Olha' })
    expect(browser.type).toHaveBeenCalledWith('#firstName', 'Olha', true)
    await callTool(url, 'type', { target: '#firstName', text: 'Olha', clear: false })
    expect(browser.type).toHaveBeenLastCalledWith('#firstName', 'Olha', false)
  })

  it('presses a key', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'press_key', { key: 'Enter' })
    expect(browser.press).toHaveBeenCalledWith('Enter')
  })

  it('drags one element onto another', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'drag', { from: 'text=One', to: 'text=Six' })
    expect(browser.drag).toHaveBeenCalledWith('text=One', 'text=Six', { dx: 0, dy: 0 })
  })

  // reason: a resize handle is dragged by a distance, and the nearest element
  // to that distance is not the same thing.
  it('drags by a distance when given one', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'drag', { from: '.handle', dx: 50, dy: 30 })
    expect(browser.drag).toHaveBeenCalledWith('.handle', undefined, { dx: 50, dy: 30 })
  })

  it('waits for the time to pass when nothing in particular is named', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'wait_for', { seconds: 6 })
    expect(browser.waitFor).toHaveBeenCalledWith(undefined, undefined, false, 6)
  })

  it('waits for something to appear, and for something to go', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'wait_for', { text: 'Saved' })
    expect(browser.waitFor).toHaveBeenCalledWith(undefined, 'Saved', false, 10)
    await callTool(url, 'wait_for', { target: '#spinner', gone: true, seconds: 30 })
    expect(browser.waitFor).toHaveBeenLastCalledWith('#spinner', undefined, true, 30)
  })

  // reason: a page that navigates under an automation run loses everything
  // typed into it, and a run that is not told cannot tell that from a step
  // that simply failed.
  it('reports a page the browser moved to on its own', async () => {
    const browser = automation({ takeNavigations: vi.fn(() => [{ url: 'https://demoqa.com/alerts' }]) })
    const url = await serve(deps({ browser }))
    const text = textOf(await callTool(url, 'type', { target: '#firstName', text: 'Olha' }))
    expect(text).toContain('The browser moved to https://demoqa.com/alerts.')
  })

  it('returns what an expression evaluated to, as JSON', async () => {
    const url = await serve(deps())
    expect(textOf(await callTool(url, 'evaluate', { expression: 'x' }))).toBe('{\n  "rows": 3\n}')
  })

  it('reports an expression the page refused, as an error', async () => {
    const browser = automation({ evaluate: vi.fn(async () => ({ ok: false, reason: 'TypeError: nope' }) as const) })
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'evaluate', { expression: 'boom()' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('TypeError: nope')
  })

  // reason: the path is model-supplied and names a file to hand to a web
  // page, which is the one argument here that leaves the machine.
  it('refuses to attach a file outside a project the user has open', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'upload_file', { target: '#uploadPicture', path: '/etc/passwd' })
    expect(result.isError).toBe(true)
    expect(browser.uploadFile).not.toHaveBeenCalled()
  })

  it('attaches a file inside one', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'upload_file', { target: '#uploadPicture', path: '/p/demo/shot.png' })
    expect(browser.uploadFile).toHaveBeenCalledWith('#uploadPicture', '/p/demo/shot.png')
  })

  it('sets a standing dialog policy', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'handle_dialogs', { action: 'accept', prompt_text: 'Olha' })
    expect(browser.setDialogPolicy).toHaveBeenCalledWith({ accept: true, promptText: 'Olha' })
  })

  // reason: a dialog is answered the instant it opens, so the action that
  // caused it is the only place it can be reported.
  it('reports a dialog alongside the action that opened it', async () => {
    const browser = automation({
      takeDialogs: vi.fn(() => [{ kind: 'confirm', message: 'Do you confirm action?', accepted: true }]),
    })
    const url = await serve(deps({ browser }))
    const text = textOf(await callTool(url, 'click', { target: '#confirmButton' }))
    expect(text).toContain('Clicked button "Go".')
    expect(text).toContain('A confirm said "Do you confirm action?" and was accepted.')
  })

  it('reports a dialog on a failed action too', async () => {
    const browser = automation({
      click: vi.fn(async () => ({ ok: false, reason: '#x: no element matches' }) as const),
      takeDialogs: vi.fn(() => [{ kind: 'alert', message: 'hi', accepted: false }]),
    })
    const url = await serve(deps({ browser }))
    const result = await callTool(url, 'click', { target: '#x' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('was dismissed')
  })

  it('reads the console, and says so when there is nothing in it', async () => {
    const url = await serve(deps())
    expect(textOf(await callTool(url, 'console'))).toContain('Nothing has been logged')
  })

  it('reads console entries with their level', async () => {
    const browser = automation({
      takeConsole: vi.fn(() => [{ level: 'error', text: 'TypeError: Lr.findDOMNode is not a function' }]),
    })
    const url = await serve(deps({ browser }))
    expect(textOf(await callTool(url, 'console'))).toBe(
      '[error] TypeError: Lr.findDOMNode is not a function',
    )
  })

  it('sets the viewport a layout needs', async () => {
    const browser = automation()
    const url = await serve(deps({ browser }))
    await callTool(url, 'resize', { width: 1600, height: 900 })
    expect(browser.resize).toHaveBeenCalledWith(1600, 900)
  })

  it('returns a screenshot as an image, not as text', async () => {
    const url = await serve(deps())
    const result = await callTool(url, 'screenshot')
    expect(result.content).toEqual([{ type: 'image', data: 'iVBORw0K', mimeType: 'image/png' }])
  })

  it('reports a screenshot that could not be taken', async () => {
    const browser = automation({ screenshot: vi.fn(async () => ({ ok: false, reason: 'no target' }) as const) })
    const url = await serve(deps({ browser }))
    expect((await callTool(url, 'screenshot')).isError).toBe(true)
  })
})

describe('the shape of the tool surface', () => {
  /**
   * Every tool one surface publishes.
   * @param surface - the surface to ask.
   * @returns its tool names.
   */
  async function names(surface: keyof typeof SURFACES): Promise<string[]> {
    const url = await serve(deps(), surface)
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    return ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
  }

  // reason: the harness publishes `mcp__<server>__<tool>`, so the server
  // segment already says which surface a tool belongs to. Repeating it in the
  // tool name paid for the distinction twice and buried the verb.
  it('leaves the tool a bare verb, with the surface in the namespace', async () => {
    for (const name of await names('browser')) {
      expect(name, name).not.toMatch(/^(browser|editor|view)_/)
    }
  })

  // reason: `browse_page`, `read_open_page` and `browser_read_page` were three
  // names for three nearby things, close enough that a model reached for one
  // that did not exist. Each of the three now says what it gives back.
  it('names the three ways of getting at a page distinctly', async () => {
    const published = await names('browser')
    expect(published).toContain('open')
    expect(published).toContain('read')
    expect(published).toContain('snapshot')
  })

  // reason: past 64 characters the harness hashes the published name, and a
  // hashed name is not one a model can predict from the others.
  it('publishes every name verbatim under the harness contract', async () => {
    for (const surface of Object.keys(SURFACES) as (keyof typeof SURFACES)[]) {
      for (const name of await names(surface)) {
        const published = `mcp__${SURFACES[surface].name}__${name}`
        expect(published, published).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(published.length, published).toBeLessThanOrEqual(64)
      }
    }
  })

  // reason: a hyphen is legal in that contract but would be the only one in a
  // name that is otherwise all underscores, and a model normalizes it away.
  it('names every surface with one separator', () => {
    for (const surface of Object.values(SURFACES)) {
      expect(surface.name, surface.name).not.toContain('-')
    }
  })
})

describe('the board tools', () => {
  it('offers the six board tools on the editor endpoint', async () => {
    const url = await serve(deps(), 'editor')
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    const names = ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'board_read',
        'board_create',
        'board_update',
        'board_status',
        'board_criterion',
        'board_delete',
      ]),
    )
  })

  // reason: these tools take no path — the open project is the whole of their
  // addressing — so "which project" is the one thing every one must get right.
  it('refuses when no project is open', async () => {
    const url = await serve(deps({ project: () => undefined }), 'editor')
    const result = await callTool(url, 'board_read')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('No project is open')
  })

  // reason: `roots` is every project the harness has ever registered — nine,
  // for the person this was built for — not the one open in the pane. A check
  // against its length would refuse every board tool on a machine with more
  // than one workspace, which is the ordinary case, not the edge one.
  it('works from whichever project is open, even with several roots registered', async () => {
    const project = boardFixture({ 'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n' })
    const url = await serve(deps({ roots: () => ['/p/one', '/p/two', project], project: () => project }), 'editor')
    expect(textOf(await callTool(url, 'board_read'))).toContain('Q3')
  })

  it('says a project has no board rather than creating one', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dsh-mcp-noboard-'))
    const url = await serve(deps({ project: () => project }), 'editor')
    expect(textOf(await callTool(url, 'board_read'))).toContain('no board')
  })

  it('reads a board, with its statuses and folder paths', async () => {
    const project = boardFixture({
      'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\nstatus: executing\n',
      'campaigns/q3/missions/m1/workitem.yaml': 'name: M1\nsubtype: mission\nstatus: draft\n',
    })
    const url = await serve(deps({ project: () => project }), 'editor')
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('Q3')
    expect(text).toContain('executing')
    expect(text).toContain('campaigns/q3/missions/m1')
  })

  it('creates, then reads back what it created', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    expect((await callTool(url, 'board_create', { level: 'campaign', name: 'Q3 Launch' })).isError).toBeFalsy()
    expect(textOf(await callTool(url, 'board_read'))).toContain('Q3 Launch')
  })

  // reason: the status set is fixed, and an agent learns that from the refusal
  // as much as from the description — so the refusal has to carry the list.
  it('names the six statuses when it refuses one', async () => {
    const project = boardFixture({ 'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n' })
    const url = await serve(deps({ project: () => project }), 'editor')
    const result = await callTool(url, 'board_status', { folder: 'campaigns/q3', status: 'inprogress' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('awaitingApproval')
  })

  // reason: the one rule the whole design is defined against.
  it('does not move a parent when a child is marked done', async () => {
    const project = boardFixture({
      'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\nstatus: draft\n',
      'campaigns/q3/missions/m1/workitem.yaml': 'name: M1\nsubtype: mission\nstatus: draft\n',
    })
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_status', { folder: 'campaigns/q3/missions/m1', status: 'done' })
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('[draft] campaign Q3')
    expect(text).toContain('(1/1 done)')
  })

  // reason: this is the boundary — a folder path from the model becomes a
  // directory this app writes into and moves to the trash.
  it('refuses a folder path that climbs out of the board', async () => {
    const project = boardFixture({ 'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n' })
    const url = await serve(deps({ project: () => project }), 'editor')
    expect((await callTool(url, 'board_delete', { folder: '../../..' })).isError).toBe(true)
  })

  it('reports a file it could not read alongside the rest of the board', async () => {
    const project = boardFixture({
      'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n',
      'campaigns/q3/missions/m1/workitem.yaml': 'name: [unclosed\n',
    })
    const url = await serve(deps({ project: () => project }), 'editor')
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('Q3')
    expect(text).toContain('Could not read')
  })

  // reason: board_criterion addresses a criterion by the index board_read
  // shows — an agent has no other way to learn it, so board_read has to
  // actually carry it.
  it('renders acceptance criteria with their index and tick state', async () => {
    const project = boardFixture({
      'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n',
      'campaigns/q3/missions/m1/workitem.yaml': 'name: M1\nsubtype: mission\n',
      'campaigns/q3/missions/m1/tasks/t1/workitem.yaml':
        'name: T1\nsubtype: task\nacceptance_criteria:\n  - text: it works\n    done: true\n  - text: it is fast\n    done: false\n',
    })
    const url = await serve(deps({ project: () => project }), 'editor')
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('(1/2 criteria)')
    expect(text).toContain('[x] 0. it works')
    expect(text).toContain('[ ] 1. it is fast')
  })

  it('ticks a criterion by the index board_read reported', async () => {
    const project = boardFixture({
      'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n',
      'campaigns/q3/missions/m1/workitem.yaml': 'name: M1\nsubtype: mission\n',
      'campaigns/q3/missions/m1/tasks/t1/workitem.yaml': 'name: T1\nsubtype: task\nacceptance_criteria:\n  - text: it works\n    done: false\n',
    })
    const url = await serve(deps({ project: () => project }), 'editor')
    const out = await callTool(url, 'board_criterion', { folder: 'campaigns/q3/missions/m1/tasks/t1', index: 0, done: true })
    expect(out.isError).toBeFalsy()
    expect(textOf(await callTool(url, 'board_read'))).toContain('[x] 0. it works')
  })

  // reason: silently taking the add branch and dropping the tick is a call
  // that reports success while doing something other than what was asked.
  it('refuses board_criterion given both text and index/done', async () => {
    const project = boardFixture({ 'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n' })
    const url = await serve(deps({ project: () => project }), 'editor')
    const out = await callTool(url, 'board_criterion', { folder: 'campaigns/q3', text: 'new one', index: 0, done: true })
    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain('not both')
  })

  // reason: board_update's schema table promises the per-kind fields, and a
  // bug created with board_create has no other way to fill them in.
  it("fills a bug's per-kind fields through board_update and reads them back", async () => {
    const project = boardFixture({ 'campaigns/q3/workitem.yaml': 'name: Q3\nsubtype: campaign\n' })
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'bug', name: 'Crash', parent: 'campaigns/q3' })
    const out = await callTool(url, 'board_update', {
      folder: 'campaigns/q3/bugs/crash',
      severity: 'blocker',
      steps_to_reproduce: 'open the app',
      expected: 'it opens',
      actual: 'it crashes',
      rca: 'null pointer',
      environment: 'macOS 15',
    })
    expect(out.isError).toBeFalsy()
    const text = readFileSync(join(project, '.dsh', 'tasks', 'campaigns', 'q3', 'bugs', 'crash', 'bug.yaml'), 'utf8')
    expect(text).toContain('severity: blocker')
    expect(text).toContain('steps_to_reproduce: open the app')
    expect(text).toContain('expected: it opens')
    expect(text).toContain('actual: it crashes')
    expect(text).toContain('rca: null pointer')
    expect(text).toContain('environment: macOS 15')
  })

  it('offers the two link tools alongside the rest', async () => {
    const url = await serve(deps(), 'editor')
    await rpc(url, INITIALIZE)
    const answer = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    const names = ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['board_link', 'board_run']))
  })

  it('creates a workitem at the level it was given', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    const text = textOf(await callTool(url, 'board_read'))
    expect(text).toContain('campaign Q3')
  })

  it('creates a test in the tests container', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    expect((await callTool(url, 'board_create', { level: 'test', name: 'Login' })).isError).toBeFalsy()
    expect(textOf(await callTool(url, 'board_read'))).toContain('tests/login')
  })

  it('links a test to a workitem and shows the verdict', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    await callTool(url, 'board_create', { level: 'test', name: 'Login' })
    const linked = await callTool(url, 'board_link', {
      folder: 'campaigns/q3',
      test: 'tests/login',
      result: 'pass',
    })
    expect(linked.isError).toBeFalsy()
    expect(textOf(await callTool(url, 'board_read'))).toContain('pass')
  })

  // reason: an agent learns the vocabulary from the refusal as much as from
  // the description.
  it('names the three results when it refuses one', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    await callTool(url, 'board_create', { level: 'test', name: 'Login' })
    const out = await callTool(url, 'board_link', { folder: 'campaigns/q3', test: 'tests/login', result: 'green' })
    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain('not_run')
  })

  it('records a run against a test', async () => {
    const project = boardFixture({})
    const url = await serve(deps({ project: () => project }), 'editor')
    await callTool(url, 'board_create', { level: 'campaign', name: 'Q3' })
    await callTool(url, 'board_create', { level: 'test', name: 'Login' })
    const out = await callTool(url, 'board_run', {
      test: 'tests/login',
      workitem: 'campaigns/q3',
      result: 'fail',
    })
    expect(out.isError).toBeFalsy()
  })
})
