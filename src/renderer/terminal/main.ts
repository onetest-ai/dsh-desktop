import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { followHarnessTheme } from '../pane/theme.ts'
import { palette } from './palette.ts'

/** What the preload exposes to this page. */
declare global {
  interface Window {
    terminal: {
      start(cols: number, rows: number): Promise<{ id: number; cwd: string; shell: string } | { error: string }>
      input(id: number, data: string): void
      resize(id: number, cols: number, rows: number): void
      ack(id: number, chars: number): void
      onData(listener: (id: number, data: string) => void): void
      onExit(listener: (id: number, code: number) => void): void
      onFailed(listener: (id: number, reason: string) => void): void
      askTheme(): void
      onTheme(listener: (dark: boolean) => void): void
    }
  }
}

/** Characters drawn before the panel acknowledges them; see `pty-flow.ts`. */
const ACK_CHARS = 5_000

/**
 * One element by id.
 * @param id - the element's id.
 * @returns the element, which the page always declares.
 */
function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`terminal: the page declares no #${id}`)
  return node
}

const surface = el('terminal-surface')
const message = el('terminal-message')

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  // Enough to scroll back through a build's output without holding a session
  // of it in memory.
  scrollback: 5_000,
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(surface)

/** The running shell, or undefined before one starts or after it exits. */
let session: number | undefined
/** Characters drawn since the last acknowledgement. */
let drawn = 0

/**
 * Say why there is no terminal, where the terminal would be.
 * @param text - what to show, or '' to clear it.
 */
function report(text: string): void {
  message.textContent = text
  message.hidden = text === ''
}

/** Apply the harness's palette to xterm, which owns its own colours. */
function repaint(): void {
  term.options.theme = palette(document.body)
}

/**
 * Fit the terminal to the panel and tell the shell its new size.
 *
 * The shell is told rather than left to guess: without it, `vim` and `less`
 * draw for the size the terminal started at.
 */
function resize(): void {
  fit.fit()
  if (session !== undefined) window.terminal.resize(session, term.cols, term.rows)
}

window.terminal.onData((id, data) => {
  if (id !== session) return
  term.write(data, () => {
    // Acknowledged after the write has been drawn, not when it arrived: the
    // count is what tells the pty the panel has kept up. See `pty-flow.ts`.
    drawn += data.length
    if (drawn < ACK_CHARS) return
    window.terminal.ack(id, drawn)
    drawn = 0
  })
})

window.terminal.onExit((id, code) => {
  if (id !== session) return
  session = undefined
  report(code === 0 ? 'The shell exited. Close and reopen the panel to start another.' : `The shell exited with code ${String(code)}.`)
})

window.terminal.onFailed((id, reason) => {
  if (id !== session) return
  session = undefined
  report(reason)
})

term.onData((data) => {
  if (session !== undefined) window.terminal.input(session, data)
})

// Sets the attribute the vendored token sheet keys on, then hands back the
// answer so xterm — which owns its own colours and reads no CSS — is repainted
// with the values that attribute just changed.
followHarnessTheme(() => {
  repaint()
})

new ResizeObserver(() => {
  resize()
}).observe(surface)

/**
 * Start the shell for this panel.
 * @returns resolution once it has started, or the reason it did not.
 */
async function begin(): Promise<void> {
  fit.fit()
  const started = await window.terminal.start(term.cols, term.rows)
  if ('error' in started) {
    report(started.error)
    return
  }
  session = started.id
  el('terminal-cwd').textContent = started.cwd
  el('terminal-title').textContent = started.shell.split('/').pop() ?? 'Terminal'
  report('')
  term.focus()
}

repaint()
void begin()
