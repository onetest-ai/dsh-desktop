import { createServer, type Server } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { readBoard, type Board, type Entity } from './board/board-read'
import { addCriterion, createEntity, setStatus, tickCriterion, trashEntity, updateEntity } from './board/board-write'
import { ENTITY_STATUSES } from './board/entity-schema'
import type { ActionResult } from './browser-actions'
import type { ConsoleEntry, DialogRecord, Evaluated, NavigationRecord } from './browser-cdp'
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
  /**
   * Load a page in the web view and return its readable text.
   * @param url - the page to load.
   * @returns the page, or why it could not be read.
   */
  fetchPage(url: string): Promise<PageText>
  /**
   * Read the page the web view is already showing.
   * @returns the page, or why it could not be read.
   */
  readPage(): Promise<PageText>
  /** Driving the built-in browser. */
  browser: BrowserAutomation
}

/**
 * Driving the built-in browser, as the tools use it.
 *
 * Every element is named the way `browser_snapshot` numbered it, or by CSS
 * selector, or by `text=`; the implementation resolves all three.
 */
export interface BrowserAutomation {
  /** Number the page's interactive elements and describe them. */
  readPage(): Promise<ActionResult>
  /** Click an element. */
  click(target: string, options: { button?: 'left' | 'right' | 'middle'; count?: number }): Promise<ActionResult>
  /** Move the pointer onto an element. */
  hover(target: string): Promise<ActionResult>
  /** Type into a field, optionally emptying it first. */
  type(target: string, text: string, clear: boolean): Promise<ActionResult>
  /** Press one key wherever focus is. */
  press(key: string): Promise<ActionResult>
  /** Choose an option in a native select. */
  selectOption(target: string, value: string): Promise<ActionResult>
  /** Drag one element onto another, by an offset, or both. */
  drag(from: string, to: string | undefined, offset: { dx: number; dy: number }): Promise<ActionResult>
  /** Press on an element and hold, so the drag can be steered call by call. */
  dragStart(from: string): Promise<ActionResult>
  /** Move a held drag, and keep holding it. */
  dragMove(to: string | undefined, offset: { dx: number; dy: number }): Promise<ActionResult>
  /** Move a held drag to its destination and let go. */
  dragDrop(to: string | undefined, offset: { dx: number; dy: number }): Promise<ActionResult>
  /** Let go of a held drag without dropping it. */
  dragCancel(): Promise<ActionResult>
  /** Run an expression in the page. */
  evaluate(expression: string): Promise<Evaluated>
  /** Put a file on a file input; the path is checked by the caller. */
  uploadFile(target: string, path: string): Promise<ActionResult>
  /** Give the page a viewport of a chosen size, or 0 to stop overriding it. */
  resize(width: number, height: number): Promise<ActionResult>
  /** Capture the page as a base64 PNG. */
  screenshot(): Promise<{ ok: true; png: string } | { ok: false; reason: string }>
  /** Decide what happens to native dialogs from now on. */
  setDialogPolicy(policy: { accept: boolean; promptText?: string }): Promise<void>
  /** Read and empty what the page logged. */
  takeConsole(): ConsoleEntry[]
  /** Read and empty the dialogs that opened. */
  takeDialogs(): Promise<DialogRecord[]>
  /** Read and empty the pages the browser moved to on its own. */
  takeNavigations(): NavigationRecord[]
  /** Wait for something to appear on the page, or to go. */
  waitFor(target: string | undefined, text: string | undefined, gone: boolean, seconds: number): Promise<ActionResult>
}

/** A page as the agent reads it. */
export type PageText =
  | { ok: true; url: string; title: string; text: string }
  | { ok: false; reason: string }

/** A running view-tools server. */
export interface ViewServer {
  /** The port it is listening on. */
  port: number
  /** Stop listening and drop every session. */
  close(): Promise<void>
}

/**
 * The surfaces this app serves, each its own MCP server on its own path.
 *
 * One server per surface rather than one server with prefixed tool names: the
 * harness publishes every tool as `mcp__<server>__<tool>`, so the server
 * segment is already there to say which surface a tool belongs to. Spending it
 * on one name for everything meant paying for the distinction twice — once in
 * `desktop_views`, again in a `browser_`/`editor_` prefix on each tool — and
 * left the verb buried at the end of a long name.
 *
 * Underscored throughout: a hyphen is legal in the harness's name contract but
 * would be the only one in a name that is otherwise all underscores, and a
 * model normalizes it away and calls a tool that does not exist.
 */
export const SURFACES = {
  /** The page in the Web tab, and everything that drives it. */
  browser: { name: 'app_browser', path: '/browser' },
  /** The editor column beside the conversation. */
  editor: { name: 'app_editor', path: '/editor' },
} as const

/** One MCP server this app serves. */
export interface ServedSurface {
  /** The name the harness namespaces this surface's tools under. */
  name: string
  /** The path it answers on. */
  path: string
}

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
 * The project a board tool acts on.
 *
 * The board belongs to one project, and these tools take no path — so the open
 * project is the whole of their addressing. Several open projects is refused
 * rather than guessed: writing a plan into whichever one happened to be first
 * is not a mistake to make on the user's behalf.
 * @param roots - the projects the harness has opened.
 * @returns the project, or why there is not exactly one.
 */
function boardProject(roots: string[]): { ok: true; project: string } | { ok: false; reason: string } {
  if (roots.length === 0) return { ok: false, reason: 'No project is open, so there is no board.' }
  if (roots.length > 1) return { ok: false, reason: 'More than one project is open, so which board is ambiguous.' }
  return { ok: true, project: roots[0] }
}

/**
 * The board as an agent reads it: one line per entity, indented by depth.
 *
 * Lines rather than JSON. An agent reads this to decide what to do next, and
 * an indented list of names with their statuses and progress is what that
 * decision is made from — a nested object costs more tokens to say the same
 * thing and is harder to scan.
 * @param board - the board to render.
 * @returns the text, including findings when there are any.
 */
function renderBoard(board: Board): string {
  if (!board.present) return 'This project has no board. Create a campaign to start one.'
  const lines: string[] = []
  const walk = (entity: Entity, depth: number): void => {
    const progress = entity.progress.total > 0 ? `  (${String(entity.progress.done)}/${String(entity.progress.total)} done)` : ''
    lines.push(`${'  '.repeat(depth)}[${entity.status}] ${entity.kind} ${entity.name}${progress}`)
    lines.push(`${'  '.repeat(depth)}  ${entity.folderPath}`)
    for (const child of entity.children) walk(child, depth + 1)
  }
  for (const campaign of board.campaigns) walk(campaign, 0)
  if (lines.length === 0) lines.push('The board is empty.')
  if (board.findings.length > 0) {
    lines.push('', 'Could not read:')
    for (const finding of board.findings) lines.push(`  ${finding.folderPath}: ${finding.says}`)
  }
  return lines.join('\n')
}

/**
 * Build one surface's MCP server and register its tools.
 * @param surface - which surface's tools to register.
 * @param deps - what the tools act on.
 * @returns the server, not yet connected to a transport.
 */
function buildServer(surface: keyof typeof SURFACES, deps: ViewDeps): McpServer {
  const server = new McpServer({ name: `dsh-${SURFACES[surface].name}`, version: '0.1.0' })
  const editor = surface === 'editor'
  const browser = surface === 'browser'

  if (editor) server.registerTool(
    'open_file',
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

  if (browser) server.registerTool(
    'show',
    {
      title: 'Show a page in the built-in browser',
      description:
        "Put a web page on screen in the desktop app's built-in browser, beside the conversation, and return nothing. Use this to show the user a page. Use `open` instead when you want to read the page yourself — it loads the same browser and hands back the text. http and https only.",
      inputSchema: { url: z.string().describe('The http or https URL to load.') },
    },
    ({ url }) => {
      if (!loadableUrl(url)) return refuse(`${url} is not an http or https URL.`)
      deps.openUrl(url)
      return done(`Showing ${url}.`)
    },
  )

  if (editor) server.registerTool(
    'show_diff',
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

  if (browser) server.registerTool(
    'open',
    {
      title: 'Read a web page in the desktop browser',
      description:
        "Open a URL in the desktop app's built-in browser and read the page as text. Use this to read something on the web: it is a real browser with the user's session, so it renders pages that a plain fetch returns empty, and the user watches it load. It waits for the page's own load event. To act on the page once it is open — click, type, drag, upload — use the browser_* tools, which drive this same browser.",
      inputSchema: { url: z.string().describe('The http or https URL to read.') },
    },
    async ({ url }) => {
      if (!loadableUrl(url)) return refuse(`${url} is not an http or https URL.`)
      const page = await deps.fetchPage(url)
      return page.ok ? done(`# ${page.title}\n${page.url}\n\n${page.text}`) : refuse(page.reason)
    },
  )

  if (browser) server.registerTool(
    'read',
    {
      title: 'Read the page the desktop browser is showing',
      description:
        "Read whatever page the desktop app's built-in browser is currently showing as text — including one the user navigated to themselves. Use `open` to load a URL of your own, and `snapshot` when you need the page's controls rather than its prose.",
      inputSchema: {},
    },
    async () => {
      const page = await deps.readPage()
      return page.ok ? done(`# ${page.title}\n${page.url}\n\n${page.text}`) : refuse(page.reason)
    },
  )

  /**
   * Report an action, with anything the page popped up while it ran.
   *
   * Dialogs are answered as they open — a page left blocked on one would hang
   * every call after it — so the only place they can be reported is alongside
   * whatever caused them.
   * @param result - what the action reported.
   * @returns the tool result.
   */
  async function acted(result: ActionResult): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
    const dialogs = (await deps.browser.takeDialogs()).map(
      (each) =>
        `A ${each.kind} said ${JSON.stringify(each.message)} and was ${each.accepted ? 'accepted' : 'dismissed'}.`,
    )
    const moved = deps.browser
      .takeNavigations()
      .map((each) => `The browser moved to ${each.url}.`)
    const notes = [...dialogs, ...moved]
    const trailer = notes.length === 0 ? '' : `\n${notes.join('\n')}`
    return result.ok ? done(result.message + trailer) : refuse(result.reason + trailer)
  }

  const target = z
    .string()
    .describe(
      'The element: `ref=N` from browser_snapshot, a CSS selector, or `text=Some visible text`.',
    )

  if (browser) server.registerTool(
    'snapshot',
    {
      title: 'List what can be acted on in the built-in browser',
      description:
        "Number every interactive element on the page the desktop app's built-in browser is showing, with its role, name, id, and value. Call this before acting on a page and after anything changes it: the numbers it returns (`ref=N`) are how the other tools here name an element, and they are more reliable than a CSS selector guessed from memory. Use `read` instead when you want the page's prose rather than its controls.",
      inputSchema: {},
    },
    async () => await acted(await deps.browser.readPage()),
  )

  if (browser) server.registerTool(
    'click',
    {
      title: 'Click in the built-in browser',
      description:
        "Click an element in the desktop app's built-in browser. The click is dispatched through the DevTools protocol, so the page cannot tell it from the user's own — it opens native dialogs, works on file inputs, and triggers handlers that ignore scripted events. Any dialog the click opens is answered and reported back; set `handle_dialogs` first to decide how.",
      inputSchema: {
        target,
        button: z.enum(['left', 'right', 'middle']).optional().describe('Which button; left by default.'),
        count: z.number().int().min(1).max(3).optional().describe('1 for a click, 2 for a double click.'),
      },
    },
    async ({ target: element, button, count }) => await acted(await deps.browser.click(element, { button, count })),
  )

  if (browser) server.registerTool(
    'hover',
    {
      title: 'Hover in the built-in browser',
      description:
        "Move the pointer onto an element in the desktop app's built-in browser, without pressing anything. Use this for a menu or tooltip that only appears under the pointer.",
      inputSchema: { target },
    },
    async ({ target: element }) => await acted(await deps.browser.hover(element)),
  )

  if (browser) server.registerTool(
    'type',
    {
      title: 'Type into a field in the built-in browser',
      description:
        "Type into a field in the desktop app's built-in browser, one key at a time, so a date picker, autocomplete, or masked field reacts the way it does for a person. Clears the field first unless told otherwise.",
      inputSchema: {
        target,
        text: z.string().describe('What to type.'),
        clear: z.boolean().optional().describe('Empty the field first; true by default.'),
      },
    },
    async ({ target: element, text, clear }) => await acted(await deps.browser.type(element, text, clear !== false)),
  )

  if (browser) server.registerTool(
    'press_key',
    {
      title: 'Press a key in the built-in browser',
      description:
        "Press one key wherever focus is in the desktop app's built-in browser — `Enter`, `Tab`, `Escape`, `ArrowDown`, or a shortcut such as `Control+a`. Use this to commit a value a picker is holding open.",
      inputSchema: { key: z.string().describe('The key, as the DOM names it, optionally as `Modifier+Key`.') },
    },
    async ({ key }) => await acted(await deps.browser.press(key)),
  )

  if (browser) server.registerTool(
    'select_option',
    {
      title: 'Choose an option in the built-in browser',
      description:
        "Choose an option in a native `<select>` in the desktop app's built-in browser, by its value or by the label the user reads. A custom combobox is not a `<select>`: click it open and click the option instead.",
      inputSchema: { target, value: z.string().describe("The option's value or its visible label.") },
    },
    async ({ target: element, value }) => await acted(await deps.browser.selectOption(element, value)),
  )

  if (browser) server.registerTool(
    'drag',
    {
      title: 'Drag in the built-in browser',
      description:
        "Drag in the desktop app's built-in browser: onto another element, or by a distance in pixels with `dx`/`dy`, or both. The pointer is pressed, moved across in steps, and released — which is what a sortable list, a resize handle, and an HTML5 drop target all wait for; a single jump from one point to the other does nothing. Use `dx`/`dy` alone for a resize handle, where the distance is the point and no element sits where the drag should end.",
      inputSchema: {
        from: target,
        to: target.optional(),
        dx: z.number().optional().describe('Pixels to add to the drop point horizontally.'),
        dy: z.number().optional().describe('Pixels to add to the drop point vertically.'),
      },
    },
    async ({ from, to, dx, dy }) =>
      await acted(await deps.browser.drag(from, to, { dx: dx ?? 0, dy: dy ?? 0 })),
  )

  if (browser) server.registerTool(
    'drag_start',
    {
      title: 'Begin a drag in the built-in browser',
      description:
        "Press on an element in the desktop app's built-in browser and hold, without releasing. Use this instead of `drag` when where the item lands depends on what the page does mid-drag — a sortable list reorders under the pointer, so the row you aimed at has moved by the time you reach it, and a single path measured beforehand lands a position short. Hold it, `drag_move`, read the page to see where things now are, move again, then `drag_drop`. The reply says whether the page took it as an HTML5 drag; either way the later calls are the same. Cancel with `drag_cancel` if you change your mind — a drag left held swallows the user's own next click.",
      inputSchema: { from: target },
    },
    async ({ from }) => await acted(await deps.browser.dragStart(from)),
  )

  if (browser) server.registerTool(
    'drag_move',
    {
      title: 'Move a held drag in the built-in browser',
      description:
        "Move a drag being held in the desktop app's built-in browser, onto another element or by a distance in pixels with `dx`/`dy`, and keep holding it. The pointer sweeps across rather than jumping, which is what a sortable and an HTML5 drop target both wait for. The element is measured now, not when the drag began, so a page that has reordered is followed. Read the page between moves to see where the item has actually got to.",
      inputSchema: {
        to: target.optional(),
        dx: z.number().optional().describe('Pixels to move horizontally, when no element is named.'),
        dy: z.number().optional().describe('Pixels to move vertically, when no element is named.'),
      },
    },
    async ({ to, dx, dy }) => await acted(await deps.browser.dragMove(to, { dx: dx ?? 0, dy: dy ?? 0 })),
  )

  if (browser) server.registerTool(
    'drag_drop',
    {
      title: 'Drop a held drag in the built-in browser',
      description:
        "Move a drag being held in the desktop app's built-in browser to its destination and let go. Takes an element, a `dx`/`dy` distance, or both, the same way `drag_move` does. Nothing is being held afterwards.",
      inputSchema: {
        to: target.optional(),
        dx: z.number().optional().describe('Pixels to add to the drop point horizontally.'),
        dy: z.number().optional().describe('Pixels to add to the drop point vertically.'),
      },
    },
    async ({ to, dx, dy }) => await acted(await deps.browser.dragDrop(to, { dx: dx ?? 0, dy: dy ?? 0 })),
  )

  if (browser) server.registerTool(
    'drag_cancel',
    {
      title: 'Abandon a held drag in the built-in browser',
      description:
        "Let go of a drag being held in the desktop app's built-in browser without dropping it, leaving the page as it was. Use it when a drag cannot be finished: a button left held swallows the user's own next click, and an interception left on catches every later drag on the page, theirs included.",
      inputSchema: {},
    },
    async () => await acted(await deps.browser.dragCancel()),
  )

  if (browser) server.registerTool(
    'wait_for',
    {
      title: 'Wait for the built-in browser',
      description:
        "Wait in the desktop app's built-in browser: until an element or some visible text appears, until it goes, or — naming neither — simply until the time has passed. Use it instead of reading the page repeatedly, and to wait out something timed: a dialog a page opens seconds after a click is reported when this returns.",
      inputSchema: {
        target: target.optional(),
        text: z.string().optional().describe('Visible text to wait for, when no element is named.'),
        gone: z.boolean().optional().describe('Wait for it to disappear instead of appear.'),
        seconds: z
          .number()
          .min(1)
          .max(120)
          .optional()
          .describe('How long to wait, or how long to wait for; 10 by default.'),
      },
    },
    async ({ target: element, text, gone, seconds }) =>
      await acted(await deps.browser.waitFor(element, text, gone === true, seconds ?? 10)),
  )

  if (browser) server.registerTool(
    'evaluate',
    {
      title: 'Run JavaScript in the built-in browser',
      description:
        "Run a JavaScript expression in the page the desktop app's built-in browser is showing, and read what it returns. Use it to check state the rendered text does not show — an input's `.value`, a checkbox's `.checked`, a class, `getBoundingClientRect()`. Read with it, do not act with it: an event it dispatches is untrusted and much of the web ignores it, and a loop that clicks and re-reads inside one expression sees none of its own effects, because a framework repaints after the expression has already returned. One action per tool call.",
      inputSchema: { expression: z.string().describe('The expression; a promise is awaited.') },
    },
    async ({ expression }) => {
      const out = await deps.browser.evaluate(expression)
      return out.ok ? done(JSON.stringify(out.value ?? null, null, 2)) : refuse(out.reason)
    },
  )

  if (browser) server.registerTool(
    'upload_file',
    {
      title: 'Attach a file in the built-in browser',
      description:
        "Put a file on a file input in the desktop app's built-in browser, without opening a file chooser. The file must be inside a project the user has opened.",
      inputSchema: {
        target,
        path: z.string().describe('Absolute path to the file to attach.'),
      },
    },
    async ({ target: element, path }) => {
      const found = locate(path, deps.roots())
      if (found === undefined) return refuse(`${path} is not inside a project the user has open.`)
      return await acted(await deps.browser.uploadFile(element, path))
    },
  )

  if (browser) server.registerTool(
    'handle_dialogs',
    {
      title: 'Decide what happens to dialogs in the built-in browser',
      description:
        "Say what the desktop app's built-in browser should do with the native dialogs a page opens — `alert`, `confirm`, `prompt`, and the leave-page warning — from now on. They are dismissed by default and always answered at once, because a dialog left open blocks the page and everything after it. Whatever appeared is reported with the action that caused it.",
      inputSchema: {
        action: z.enum(['accept', 'dismiss']).describe('What to do with each dialog.'),
        prompt_text: z.string().optional().describe('What to type into a `prompt` when accepting one.'),
      },
    },
    async ({ action, prompt_text }) => {
      await deps.browser.setDialogPolicy({ accept: action === 'accept', promptText: prompt_text })
      return done(`Dialogs will be ${action === 'accept' ? 'accepted' : 'dismissed'} from now on.`)
    },
  )

  if (browser) server.registerTool(
    'console',
    {
      title: "Read the built-in browser's console",
      description:
        "Read what the page logged in the desktop app's built-in browser — console messages, uncaught exceptions, and failed loads — since the last time this was read. Use it to check that an interaction produced no error, or to see the error it produced.",
      inputSchema: {},
    },
    () => {
      const entries = deps.browser.takeConsole()
      return done(
        entries.length === 0
          ? 'Nothing has been logged since the last read.'
          : entries.map((each) => `[${each.level}] ${each.text}`).join('\n'),
      )
    },
  )

  if (browser) server.registerTool(
    'resize',
    {
      title: 'Set the viewport of the built-in browser',
      description:
        "Change the viewport the page measures in the desktop app's built-in browser, without moving the window the user arranged. Use it when a layout depends on width — a table that collapses, an advert that overlaps a control. Pass 0 for both to go back to the real column width.",
      inputSchema: {
        width: z.number().int().min(0).max(10_000).describe('Width in CSS pixels, or 0 to stop overriding.'),
        height: z.number().int().min(0).max(10_000).describe('Height in CSS pixels.'),
      },
    },
    async ({ width, height }) => await acted(await deps.browser.resize(width, height)),
  )

  if (browser) server.registerTool(
    'screenshot',
    {
      title: 'Photograph the built-in browser',
      description:
        "Capture what the desktop app's built-in browser is showing, as a PNG. Use it as evidence of a state, or to see a layout that the page's text does not describe.",
      inputSchema: {},
    },
    async () => {
      const shot = await deps.browser.screenshot()
      return shot.ok
        ? { content: [{ type: 'image' as const, data: shot.png, mimeType: 'image/png' }] }
        : refuse(shot.reason)
    },
  )

  if (editor) server.registerTool(
    'selection',
    {
      title: 'Read the editor selection',
      description:
        "Read what the user has selected in the desktop app's editor. Empty when nothing is selected or no file is open.",
      inputSchema: {},
    },
    async () => done(await deps.selection()),
  )

  if (editor) server.registerTool(
    'board_read',
    {
      title: 'Read the project board',
      description:
        "The whole board for the open project: campaigns, their missions, the tasks and bugs under them, each with its status and folder path. The board is YAML files under `.dsh/tasks/`, committed with the code. Read this before planning work, and read it again before claiming any of it is done — someone else may have moved it. Every other board tool addresses an entity by the folder path this returns.",
      inputSchema: {},
    },
    () => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      return done(renderBoard(readBoard(project.project)))
    },
  )

  if (editor) server.registerTool(
    'board_create',
    {
      title: 'Add something to the project board',
      description:
        "Create a campaign, mission, task or bug. A campaign is an outcome; a mission is an independently shippable slice of it; a task is one small verifiable unit; a bug is a defect. A mission goes under a campaign, a task under a mission, and a bug under either. Give `parent` the folder path from board_read — omit it only for a campaign. A task should be given at least one acceptance criterion with board_criterion: a task with no checkable definition of done cannot be gated.",
      inputSchema: {
        kind: z.enum(['campaign', 'mission', 'task', 'bug']).describe('What to create.'),
        name: z.string().describe('The display name. The folder is named after it.'),
        parent: z.string().optional().describe("The parent's folder path from board_read. Omit for a campaign."),
      },
    },
    ({ kind, name, parent }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const out = createEntity(project.project, kind, parent ?? '', name)
      return out.ok ? done(`Created ${out.folderPath}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_update',
    {
      title: 'Edit an entity on the board',
      description:
        "Change an entity's name, description or notes. Notes are free-form prose for decisions, rationale and sign-offs — appended reasoning that outlives the conversation it was decided in. This does not change status: use board_status for that.",
      inputSchema: {
        folder: z.string().describe('The folder path from board_read.'),
        name: z.string().optional().describe('A new display name. The folder does not move.'),
        description: z.string().optional().describe('What this entity is.'),
        notes: z.string().optional().describe('Decisions and rationale, in prose.'),
      },
    },
    ({ folder, name, description, notes }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const patch = { ...(name !== undefined && { name }), ...(description !== undefined && { description }), ...(notes !== undefined && { notes }) }
      if (Object.keys(patch).length === 0) return refuse('Name at least one field to change.')
      const out = updateEntity(project.project, folder, patch)
      return out.ok ? done(`Updated ${folder}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_status',
    {
      title: 'Move an entity to a status',
      description:
        `Set one entity's status to one of: ${ENTITY_STATUSES.join(', ')}. Nothing else changes it — a mission does not become done because its last task did, and a campaign does not start because a mission did. A status is a claim, so make it deliberately, and only for the entity you are actually talking about.`,
      inputSchema: {
        folder: z.string().describe('The folder path from board_read.'),
        status: z.string().describe(`One of: ${ENTITY_STATUSES.join(', ')}.`),
      },
    },
    ({ folder, status }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const out = setStatus(project.project, folder, status)
      return out.ok ? done(`${folder} is now ${status}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_criterion',
    {
      title: 'Add or tick an acceptance criterion',
      description:
        "Add a criterion to an entity, or tick one that is now met. A criterion is a statement that is checkably true or false about observable behaviour — not a description of the work. Give `text` to add one; give `index` and `done` to tick or clear one, where index is its zero-based position in the list board_read shows. Ticking is a claim that you verified it, not that you intended it.",
      inputSchema: {
        folder: z.string().describe('The folder path from board_read.'),
        text: z.string().optional().describe('A new criterion, added unticked.'),
        index: z.number().optional().describe('Zero-based position of the criterion to tick.'),
        done: z.boolean().optional().describe('True to tick it, false to clear it.'),
      },
    },
    ({ folder, text, index, done: ticked }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      if (text !== undefined) {
        const out = addCriterion(project.project, folder, text)
        return out.ok ? done(`Added a criterion to ${folder}.`) : refuse(out.reason)
      }
      if (index === undefined || ticked === undefined) return refuse('Give either text to add one, or index and done to tick one.')
      const out = tickCriterion(project.project, folder, index, ticked)
      return out.ok ? done(`${ticked ? 'Ticked' : 'Cleared'} criterion ${String(index)} on ${folder}.`) : refuse(out.reason)
    },
  )

  if (editor) server.registerTool(
    'board_delete',
    {
      title: 'Move a board entity to the trash',
      description:
        "Move an entity, and everything under it, to `.dsh/tasks/.trash/`. It leaves the board but stays on disk, so a delete made in error is recoverable. Deleting a campaign takes its missions, tasks and bugs with it.",
      inputSchema: { folder: z.string().describe('The folder path from board_read.') },
    },
    ({ folder }) => {
      const project = boardProject(deps.roots())
      if (!project.ok) return refuse(project.reason)
      const out = trashEntity(project.project, folder)
      return out.ok ? done(`Moved ${folder} to the board's trash.`) : refuse(out.reason)
    },
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
    const surface = (Object.keys(SURFACES) as (keyof typeof SURFACES)[])
      .find((key) => SURFACES[key].path === url.pathname)
    if (surface === undefined) {
      response.writeHead(404).end()
      return
    }
    void (async () => {
      const server = buildServer(surface, deps)
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
