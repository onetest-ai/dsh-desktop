import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveViewTools, type ViewDeps, type ViewServer } from './view-mcp'

let running: ViewServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Deps recording what the tools did. */
function deps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  return {
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
      'browse_page',
      'read_open_page',
      'view_get_selection',
      'view_open_file',
      'view_open_url',
      'view_show_diff',
    ])
  })

  // reason: this is what the browser is for — reading the web through a real
  // browser rather than a plain fetch, with the user watching it load.
  it('reads a page it opened, title and address included', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'browse_page', { url: 'https://example.com' })
    expect(d.fetchPage).toHaveBeenCalledWith('https://example.com')
    expect(textOf(result)).toContain('A page')
    expect(textOf(result)).toContain('the content')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'not a url'])('refuses to read %s', async (target) => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'browse_page', { url: target })
    expect(d.fetchPage).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('reports why a page could not be read, rather than returning nothing', async () => {
    const d = deps({
      fetchPage: vi.fn(async () => ({ ok: false, reason: 'https://slow.example did not finish loading.' }) as const),
    })
    const url = await serve(d)
    const result = await callTool(url, 'browse_page', { url: 'https://slow.example' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('did not finish loading')
  })

  // reason: the user may have navigated there themselves, which is the point
  // of a browser they can see.
  it('reads whatever the browser is already showing', async () => {
    const d = deps()
    const url = await serve(d)
    expect(textOf(await callTool(url, 'read_open_page'))).toContain('the content')
    expect(d.readPage).toHaveBeenCalled()
  })

  it('says so when the browser has nothing open', async () => {
    const d = deps({ readPage: vi.fn(async () => ({ ok: false, reason: 'The browser has no page open yet.' }) as const) })
    const url = await serve(d)
    const result = await callTool(url, 'read_open_page')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no page open')
  })

  it('opens a file inside an open project', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'view_open_file', { path: '/p/demo/src/index.ts' })
    expect(d.openFile).toHaveBeenCalledWith('/p/demo', 'src/index.ts')
    expect(textOf(result)).toContain('src/index.ts')
  })

  // reason: these arguments come from the model. A refusal that reaches it as
  // content lets it pick a different path; a protocol error does not.
  it('refuses a file outside every open project, and says so in the result', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'view_open_file', { path: '/etc/passwd' })
    expect(d.openFile).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('not inside a project')
  })

  it('opens an https page', async () => {
    const d = deps()
    const url = await serve(d)
    await callTool(url, 'view_open_url', { url: 'https://example.com' })
    expect(d.openUrl).toHaveBeenCalledWith('https://example.com')
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)'])('refuses to load %s', async (target) => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'view_open_url', { url: target })
    expect(d.openUrl).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('shows a proposed change without writing it', async () => {
    const d = deps()
    const url = await serve(d)
    await callTool(url, 'view_show_diff', { path: '/p/demo/readme.md', proposed: '# new' })
    expect(d.showDiff).toHaveBeenCalledWith('/p/demo', 'readme.md', '# new')
  })

  it('refuses a diff for a file outside every open project', async () => {
    const d = deps()
    const url = await serve(d)
    const result = await callTool(url, 'view_show_diff', { path: '/etc/hosts', proposed: 'x' })
    expect(d.showDiff).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('reports the editor selection', async () => {
    const url = await serve(deps())
    expect(textOf(await callTool(url, 'view_get_selection'))).toBe('selected text')
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
