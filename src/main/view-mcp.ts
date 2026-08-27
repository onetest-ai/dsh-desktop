import { createServer, type Server } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { loadableUrl, locate } from './view-tools'

/** What the tools need from the app. */
export interface ViewDeps {
  /** The projects the harness has opened; every path argument is checked against these. */
  roots(): string[]
  /** Show a file in the editor column, opening it if it is closed. */
  openFile(root: string, relative: string): void
  /** Show a page in the web view. */
  openUrl(url: string): void
  /** Show a file beside the text the agent proposes for it. */
  showDiff(root: string, relative: string, proposed: string): void
  /** What the user has selected in the editor, or '' when nothing is. */
  selection(): Promise<string>
}

/** A running view-tools server. */
export interface ViewServer {
  /** The port it is listening on. */
  port: number
  /** Stop listening and drop every session. */
  close(): Promise<void>
}

/** What the harness's MCP client is told this server is called. */
export const VIEW_SERVER_NAME = 'desktop-views'

/** The one path the server answers on, matching the URL written into `mcp.json`. */
const ENDPOINT = '/mcp'

/**
 * Tool result for a refused call.
 *
 * Refusals come back as content rather than as protocol errors: the model
 * should read why and pick a different path, which a transport-level failure
 * does not let it do.
 * @param message - what was refused and why.
 * @returns the tool result.
 */
function refuse(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/** Tool result for a call that did what it said. */
function done(message: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: message }] }
}

/**
 * Build the MCP server and register its tools.
 * @param deps - what the tools act on.
 * @returns the server, not yet connected to a transport.
 */
function buildServer(deps: ViewDeps): McpServer {
  const server = new McpServer({ name: 'dsh-desktop-views', version: '0.1.0' })

  server.registerTool(
    'view_open_file',
    {
      title: 'Open a file in the desktop editor',
      description:
        "Show a file in the desktop app's editor column, beside the conversation. The path must be inside a project the user has opened. Use this to put a file in front of the user, not to read it.",
      inputSchema: { path: z.string().describe('Absolute path to the file.') },
    },
    ({ path }) => {
      const found = locate(path, deps.roots())
      if (found === undefined) return refuse(`${path} is not inside a project the user has open.`)
      deps.openFile(found.root, found.relative)
      return done(`Showing ${found.relative}.`)
    },
  )

  server.registerTool(
    'view_open_url',
    {
      title: 'Open a page in the desktop web view',
      description:
        "Show a web page in the desktop app's Web tab, beside the conversation. http and https only.",
      inputSchema: { url: z.string().describe('The http or https URL to load.') },
    },
    ({ url }) => {
      if (!loadableUrl(url)) return refuse(`${url} is not an http or https URL.`)
      deps.openUrl(url)
      return done(`Showing ${url}.`)
    },
  )

  server.registerTool(
    'view_show_diff',
    {
      title: 'Show a proposed change',
      description:
        'Show a file beside the text you propose for it, as a diff the user can read before you write anything. The file is not changed.',
      inputSchema: {
        path: z.string().describe('Absolute path to the file as it exists now.'),
        proposed: z.string().describe('The full text you propose for that file.'),
      },
    },
    ({ path, proposed }) => {
      const found = locate(path, deps.roots())
      if (found === undefined) return refuse(`${path} is not inside a project the user has open.`)
      deps.showDiff(found.root, found.relative, proposed)
      return done(`Showing the proposed change to ${found.relative}.`)
    },
  )

  server.registerTool(
    'view_get_selection',
    {
      title: 'Read the editor selection',
      description:
        "Read what the user has selected in the desktop app's editor. Empty when nothing is selected or no file is open.",
      inputSchema: {},
    },
    async () => done(await deps.selection()),
  )

  return server
}

/**
 * Serve the view tools on loopback.
 *
 * Loopback only, deliberately: these tools drive the window in front of the
 * user, and nothing off this machine has any business doing that. Each
 * request gets its own transport and server instance — the SDK's stateless
 * mode — because the client here is the harness, which opens a request per
 * call and keeps no session.
 * @param port - the port to listen on; 0 asks the OS for a free one.
 * @param deps - what the tools act on.
 * @returns the running server.
 */
export async function serveViewTools(port: number, deps: ViewDeps): Promise<ViewServer> {
  const http: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== ENDPOINT) {
      response.writeHead(404).end()
      return
    }
    void (async () => {
      const server = buildServer(deps)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      // Closed together: a stateless request owns both, and leaving either
      // behind would leak one server per tool call.
      response.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(request, response)
    })()
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', resolve)
  })
  const address = http.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : port,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve())
      }),
  }
}
