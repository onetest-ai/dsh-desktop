import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { palette } from './palette.ts'

/** Characters drawn before the panel acknowledges them; see `pty-flow.ts`. */
const ACK_CHARS = 5_000

/** One shell, its terminal, and the element it draws into. */
export interface Session {
  /** The id main addresses this shell by. */
  readonly id: number
  /** Where it was started, which it keeps for its whole life. */
  readonly cwd: string
  /** What is running in it. */
  readonly shell: string
  /** The element holding its terminal; hidden while another session is shown. */
  readonly surface: HTMLElement
  /** Draw output, acknowledging it once enough has been drawn. */
  write(data: string): void
  /** Resize to the surface and tell the shell its new size. */
  fit(): void
  /** Take the keyboard. */
  focus(): void
  /** Re-read the palette, which xterm holds rather than reading from CSS. */
  repaint(): void
  /** Say why the shell is gone, in place of its output. */
  report(message: string): void
  /** Throw the terminal away; the shell is main's to kill. */
  dispose(): void
}

/** What a session needs from the page around it. */
export interface SessionDeps {
  /** Send typed input to the shell. */
  input(id: number, data: string): void
  /** Tell the shell the terminal's size. */
  resize(id: number, cols: number, rows: number): void
  /** Report characters drawn, so the pty may keep sending. */
  ack(id: number, chars: number): void
}

/**
 * Build a terminal for one shell.
 *
 * Each session owns its terminal rather than sharing one and swapping
 * buffers: a shared terminal loses scrollback, selection, and cursor position
 * on every tab switch, which is most of what a second terminal is for.
 * @param started - what main said it started.
 * @param deps - how to reach the shell.
 * @returns the session.
 */
export function createSession(
  started: { id: number; cwd: string; shell: string },
  deps: SessionDeps,
): Session {
  const surface = document.createElement('div')
  surface.className = 'terminal-surface'

  const message = document.createElement('p')
  message.className = 'terminal-message'
  message.hidden = true

  const screen = document.createElement('div')
  screen.className = 'terminal-screen'
  surface.append(screen, message)

  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontSize: 12,
    // Rows sit flush against each other at the default 1.0, which reads as one
    // block of text rather than as lines.
    lineHeight: 1.25,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    scrollback: 5_000,
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(screen)

  // The GPU renderer, with xterm's DOM renderer as the fallback it falls back
  // to on its own. The DOM renderer positions each cell with layout rather
  // than drawing to a grid, so glyphs drift out of their columns.
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      webgl.dispose()
    })
    term.loadAddon(webgl)
  } catch {
    // No GPU context in this window; the DOM renderer draws well enough.
  }

  term.onData((data) => {
    deps.input(started.id, data)
  })

  let drawn = 0
  return {
    id: started.id,
    cwd: started.cwd,
    shell: started.shell,
    surface,
    write(data) {
      term.write(data, () => {
        // Acknowledged once drawn, not when it arrived: the count is what
        // tells the pty this panel has kept up. See `pty-flow.ts`.
        drawn += data.length
        if (drawn < ACK_CHARS) return
        deps.ack(started.id, drawn)
        drawn = 0
      })
    },
    fit() {
      // A hidden surface measures zero, and fitting to it would tell the
      // shell it is one column wide.
      if (surface.clientWidth === 0 || surface.clientHeight === 0) return
      fitAddon.fit()
      deps.resize(started.id, term.cols, term.rows)
    },
    focus() {
      term.focus()
    },
    repaint() {
      term.options.theme = palette(document.body)
    },
    report(text) {
      message.textContent = text
      message.hidden = text === ''
    },
    dispose() {
      term.dispose()
      surface.remove()
    },
  }
}
