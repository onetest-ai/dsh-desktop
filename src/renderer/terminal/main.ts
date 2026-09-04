import { followHarnessTheme } from '../pane/theme.ts'
import { createSession, type Session } from './session.ts'

/** What the preload exposes to this page. */
declare global {
  interface Window {
    terminal: {
      start(cols: number, rows: number): Promise<{ id: number; cwd: string; shell: string } | { error: string }>
      input(id: number, data: string): void
      resize(id: number, cols: number, rows: number): void
      ack(id: number, chars: number): void
      kill(id: number): void
      closePanel(): void
      onData(listener: (id: number, data: string) => void): void
      onExit(listener: (id: number, code: number) => void): void
      onFailed(listener: (id: number, reason: string) => void): void
      onShown(listener: () => void): void
      onOpenNew(listener: () => void): void
      askTheme(): void
      onTheme(listener: (dark: boolean) => void): void
    }
  }
}

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

const strip = el('terminal-tabs')
const surfaces = el('terminal-surfaces')
const empty = el('terminal-empty')

/** Every shell this panel has open, in the order their tabs are shown. */
const sessions: Session[] = []
/** The session showing, or undefined when none is. */
let active: number | undefined

const deps = {
  input: (id: number, data: string) => {
    window.terminal.input(id, data)
  },
  resize: (id: number, cols: number, rows: number) => {
    window.terminal.resize(id, cols, rows)
  },
  ack: (id: number, chars: number) => {
    window.terminal.ack(id, chars)
  },
}

/**
 * The session with an id, or undefined when it has gone.
 * @param id - the session's id.
 * @returns the session.
 */
function find(id: number): Session | undefined {
  return sessions.find((session) => session.id === id)
}

/** Draw the tab strip from the sessions, marking the active one. */
function drawTabs(): void {
  strip.textContent = ''
  for (const session of sessions) {
    const tab = document.createElement('div')
    tab.className = 'terminal-tab'
    if (session.id === active) tab.classList.add('is-active')

    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'terminal-tab-label'
    label.textContent = session.shell.split('/').pop() ?? 'shell'
    // The directory a terminal was started in never changes, and is the only
    // thing that distinguishes two shells with the same name.
    label.title = session.cwd
    label.addEventListener('click', () => {
      show(session.id)
    })

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'terminal-tab-close'
    close.setAttribute('aria-label', `Close ${label.textContent}`)
    close.textContent = '✕'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      closeSession(session.id)
    })

    tab.append(label, close)
    strip.append(tab)
  }
}

/**
 * Show one session and hide the rest.
 * @param id - the session to show.
 */
function show(id: number): void {
  active = id
  for (const session of sessions) session.surface.hidden = session.id !== id
  drawTabs()
  const session = find(id)
  // Fitted on the way in: a hidden surface measures zero, so a session sized
  // while it was in the background would have told its shell the wrong size.
  session?.fit()
  session?.focus()
}

/**
 * Start a shell and give it a tab.
 * @returns resolution once it has started, or the reason it did not.
 */
async function open(): Promise<void> {
  // Measured from the panel itself: the surface a new session draws into does
  // not exist yet, and every session in this panel is the same size.
  const probe = surfaces.getBoundingClientRect()
  const started = await window.terminal.start(Math.max(1, Math.floor(probe.width / 7)), Math.max(1, Math.floor(probe.height / 16)))
  if ('error' in started) {
    empty.textContent = started.error
    empty.hidden = false
    return
  }
  empty.hidden = true
  const session = createSession(started, deps)
  sessions.push(session)
  surfaces.append(session.surface)
  session.repaint()
  show(session.id)
}

/**
 * Close one session, and the panel with it when it was the last.
 *
 * The panel closing with its last terminal is what every editor does: a panel
 * left open with nothing in it is a strip of chrome asking to be dismissed
 * twice.
 * @param id - the session to close.
 */
function closeSession(id: number): void {
  const index = sessions.findIndex((session) => session.id === id)
  if (index === -1) return
  window.terminal.kill(id)
  sessions[index].dispose()
  sessions.splice(index, 1)
  if (sessions.length === 0) {
    active = undefined
    window.terminal.closePanel()
    drawTabs()
    return
  }
  show(sessions[Math.min(index, sessions.length - 1)].id)
}

window.terminal.onData((id, data) => {
  find(id)?.write(data)
})

window.terminal.onExit((id, code) => {
  const session = find(id)
  if (session === undefined) return
  // A shell that exited on its own takes its tab with it, the same as one
  // closed from the tab — the difference is not one anybody acts on.
  if (code === 0) {
    closeSession(id)
    return
  }
  session.report(`The shell exited with code ${String(code)}. Close this tab to be rid of it.`)
})

window.terminal.onFailed((id, reason) => {
  const session = find(id)
  if (session === undefined) {
    empty.textContent = reason
    empty.hidden = false
    return
  }
  session.report(reason)
})

followHarnessTheme(() => {
  for (const session of sessions) session.repaint()
})

new ResizeObserver(() => {
  if (active !== undefined) find(active)?.fit()
}).observe(surfaces)

el('terminal-new').addEventListener('click', () => {
  void open()
})
el('terminal-close').addEventListener('click', () => {
  // Every shell in the panel goes with it: a pty left running with nothing
  // drawing it holds the workspace open for no one.
  for (const session of [...sessions]) closeSession(session.id)
  window.terminal.closePanel()
})

window.terminal.onShown(() => {
  // An empty panel means every tab was closed while the panel stayed on the
  // rail, or the shell started at load has since exited. Either way, a panel
  // someone just opened should have a shell in it: this page runs once, so
  // without this it would stay empty for as long as the window lives.
  if (sessions.length === 0) {
    void open()
    return
  }
  if (active !== undefined) find(active)?.focus()
})

window.terminal.onOpenNew(() => {
  // Always a new session, never a focus: main has already decided this one
  // starts somewhere other than the project, and an existing shell cannot be
  // moved there without typing into work that may be running.
  void open()
})

void open()
