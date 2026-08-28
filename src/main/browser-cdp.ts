/**
 * The DevTools protocol session over the desktop app's own browser view.
 *
 * The protocol rather than injected JavaScript, because input a page can tell
 * apart from a user's is input half the web ignores: a dispatched `click`
 * event is untrusted, and drag, native dialogs, and file choosers have no
 * scriptable equivalent at all.
 */

/** The part of Electron's `webContents.debugger` this uses. */
export interface Debuggee {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  sendCommand(method: string, commandParams?: object): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): void
}

/** One thing the page logged. */
export interface ConsoleEntry {
  /** `log`, `warning`, `error`, and the rest of the console's own levels. */
  level: string
  /** The message as the page wrote it. */
  text: string
}

/** One page the browser moved to on its own. */
export interface NavigationRecord {
  /** The address it went to. */
  url: string
}

/** One dialog the page opened, and what was done with it. */
export interface DialogRecord {
  /** `alert`, `confirm`, `prompt`, or `beforeunload`. */
  kind: string
  /** The message the page put in it. */
  message: string
  /** Whether it was accepted. */
  accepted: boolean
}

/** What to do with dialogs as they open. */
export interface DialogPolicy {
  /** Whether to accept them; false dismisses. */
  accept: boolean
  /** What to type into a `prompt`, when accepting one. */
  promptText?: string
}

/**
 * The most console entries and dialogs kept.
 *
 * A page in a loop can log without bound, and the buffer is read into a
 * model's context; keeping the most recent is what a developer console does.
 */
export const LOG_LIMIT = 200

/**
 * How long a dialog is given to be reported after the action that opened it.
 *
 * The browser reports one a moment after the call that caused it returns, so
 * without this the dialog is attributed to whatever the model does next.
 */
const DIALOG_GRACE_MS = 80

/** What one `Runtime.evaluate` returned, or why it did not. */
export type Evaluated = { ok: true; value: unknown } | { ok: false; reason: string }

/**
 * A protocol session that attaches on demand and outlives navigation.
 *
 * The view is fetched per call rather than held: the window is rebuilt across
 * a reload, and a session pinned to a destroyed view would fail every call
 * after the first one.
 */
export class BrowserSession {
  private policy: DialogPolicy = { accept: false }
  private readonly logged: ConsoleEntry[] = []
  private readonly opened: DialogRecord[] = []
  private readonly navigated: NavigationRecord[] = []
  private listening = false
  private readonly waiting = new Map<string, ((params: Record<string, unknown>) => void)[]>()
  private attaching: Promise<Debuggee> | undefined
  private promptScript: string | undefined

  /**
   * @param debuggee - reads the current view's debugger, or undefined when
   *   there is no window.
   */
  constructor(private readonly debuggee: () => Debuggee | undefined) {}

  /**
   * Attach if not already attached, and subscribe to what the page reports.
   * @returns the attached debugger.
   * @throws when there is no window to attach to.
   */
  private async attached(): Promise<Debuggee> {
    // Detaching is not something this asks for, but it happens: opening the
    // developer tools takes the session, and a view rebuilt under this leaves
    // one behind. A cached attach that is no longer attached answers no
    // dialogs, and an unanswered dialog blocks the page and everything after
    // it — so the state is read every time rather than remembered.
    const current = this.debuggee()
    if (current !== undefined && !current.isAttached()) this.attaching = undefined
    // One attach at a time: several tool calls can arrive together, and each
    // enabling the domains again would race the first one's dialog handler
    // into place after the dialog it was meant to answer.
    this.attaching ??= this.attach()
    try {
      return await this.attaching
    } catch (error) {
      this.attaching = undefined
      throw error
    }
  }

  /**
   * Attach the debugger and make the page ready to be driven.
   * @returns the attached debugger.
   * @throws when there is no window to attach to.
   */
  private async attach(): Promise<Debuggee> {
    const target = this.debuggee()
    if (target === undefined) throw new Error('The browser is not open.')
    if (!this.listening) {
      target.on('message', (_event, method, params) => {
        this.record(method, params)
      })
      this.listening = true
    }
    if (!target.isAttached()) target.attach('1.3')
    // Awaited, not fired off: the first thing a caller does may be to click
    // something that opens a dialog, and a dialog that opens before `Page` is
    // enabled is never reported — it blocks the renderer instead, and with it
    // every call after it.
    for (const domain of ['Page', 'Runtime', 'Log']) await target.sendCommand(`${domain}.enable`)
    await this.installPrompt(target)
    return target
  }

  /**
   * Give the page a `window.prompt` that answers from the dialog policy.
   *
   * Electron does not implement `prompt`: it throws `prompt() is not
   * supported.` before any dialog exists, so there is nothing for the
   * protocol to intercept and a page that calls it fails outright. This
   * substitutes one that behaves the way an answered dialog would, so
   * `alert`, `confirm`, and `prompt` all follow the same policy.
   *
   * Installed for every future document as well as the current one, and
   * reinstalled whenever the policy changes, so the value it returns is
   * always the one that was asked for.
   * @param target - the attached debugger.
   */
  private async installPrompt(target: Debuggee): Promise<void> {
    const source = `(() => {
      const state = { accept: ${String(this.policy.accept)}, text: ${JSON.stringify(this.policy.promptText ?? '')} }
      window.__dshPrompts = window.__dshPrompts ?? []
      window.prompt = (message, fallback) => {
        window.__dshPrompts.push({ message: String(message ?? ''), accepted: state.accept })
        return state.accept ? (state.text === '' ? String(fallback ?? '') : state.text) : null
      }
    })()`
    if (source === this.promptScript) return
    this.promptScript = source
    // On the page as it is, and on every page after it: a policy set before a
    // navigation has to survive the navigation.
    await target.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source })
    await target.sendCommand('Runtime.evaluate', { expression: source })
  }

  /**
   * Keep what the page reported, and answer a dialog before it blocks.
   * @param method - the protocol event's name.
   * @param params - its payload.
   */
  private record(method: string, params: Record<string, unknown>): void {
    const waiters = this.waiting.get(method)
    if (waiters !== undefined) {
      this.waiting.delete(method)
      for (const waiter of waiters) waiter(params)
    }
    if (method === 'Runtime.consoleAPICalled') {
      const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? []
      this.keep(this.logged, {
        level: String(params.type ?? 'log'),
        text: args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '),
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
      this.keep(this.logged, {
        level: 'error',
        text: details?.exception?.description ?? details?.text ?? 'an exception with no message',
      })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry as { level?: string; text?: string } | undefined
      this.keep(this.logged, { level: entry?.level ?? 'info', text: entry?.text ?? '' })
      return
    }
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as { url?: string; parentId?: string } | undefined
      // The main frame only: a page's adverts navigate their own frames
      // constantly, and none of that moves the page the model is reading.
      if (frame !== undefined && frame.parentId === undefined) {
        this.keep(this.navigated, { url: String(frame.url ?? '') })
      }
      return
    }
    if (method === 'Page.javascriptDialogOpening') {
      // Answered immediately and unconditionally: a native dialog blocks the
      // renderer, so one left open would hang the page and every tool call
      // after it. The standing policy decides how, and what appeared is
      // recorded for whoever asks next.
      this.keep(this.opened, {
        kind: String(params.type ?? 'dialog'),
        message: String(params.message ?? ''),
        accepted: this.policy.accept,
      })
      // A dialog can be gone before this reply lands — the page can navigate
      // out from under it, and a reload dismisses it — and the protocol
      // rejects a reply to a dialog that has closed. Nothing is left to do
      // about it, and an unhandled rejection here would take down the app
      // over a dialog that is no longer on screen.
      this.debuggee()
        ?.sendCommand('Page.handleJavaScriptDialog', {
          accept: this.policy.accept,
          promptText: this.policy.promptText,
        })
        .catch(() => {})
    }
  }

  /**
   * Append to a buffer, dropping the oldest past the limit.
   * @param buffer - the buffer to append to.
   * @param entry - what to append.
   */
  private keep<T>(buffer: T[], entry: T): void {
    buffer.push(entry)
    if (buffer.length > LOG_LIMIT) buffer.splice(0, buffer.length - LOG_LIMIT)
  }

  /**
   * Attach and make the page ready to be driven, before anything asks.
   *
   * Dialogs are the reason this is not left until the first tool call. A page
   * opens them on its own — on load, on a timer, on a link the user followed —
   * and one that opens while nothing is attached is never answered: it blocks
   * the page, and every call after it, until someone dismisses it by hand.
   * @returns resolution once the page can be driven, or when it cannot be.
   */
  async ready(): Promise<void> {
    try {
      await this.attached()
    } catch {
      // No window, or a view that will not take a debugger. The tools report
      // that themselves when one of them is called; there is nothing to say
      // about it in advance.
    }
  }

  /**
   * Send one protocol command.
   * @param method - the command's name.
   * @param params - its parameters.
   * @returns what the command returned.
   */
  async send<T>(method: string, params?: object): Promise<T> {
    const target = await this.attached()
    return (await target.sendCommand(method, params)) as T
  }

  /**
   * Run an expression in the page and read its result.
   *
   * Awaited and returned by value, so an expression that resolves a promise
   * reads as the value it settles to rather than as an opaque handle.
   * @param expression - the JavaScript to run.
   * @returns its value, or the error the page raised.
   */
  async evaluate(expression: string): Promise<Evaluated> {
    let response: {
      result?: { value?: unknown; description?: string }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }
    try {
      response = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        // The page is being driven on the user's behalf, and a page that
        // gates fullscreen or autoplay behind a gesture would otherwise
        // refuse everything this does.
        userGesture: true,
      })
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
    const thrown = response.exceptionDetails
    if (thrown !== undefined) {
      return { ok: false, reason: thrown.exception?.description ?? thrown.text ?? 'the page raised an error' }
    }
    return { ok: true, value: response.result?.value }
  }

  /**
   * Wait for the next occurrence of one protocol event.
   *
   * Bounded, because the event may never come: a page that does not start a
   * native drag never reports one being intercepted, and the caller has
   * another way to proceed.
   * @param method - the event's name.
   * @param timeoutMs - how long to wait.
   * @returns the event's payload, or undefined if it did not arrive in time.
   */
  next(method: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve) => {
      const waiters = this.waiting.get(method) ?? []
      const settle = (params: Record<string, unknown> | undefined): void => {
        clearTimeout(timer)
        resolve(params)
      }
      waiters.push(settle)
      this.waiting.set(method, waiters)
      const timer = setTimeout(() => {
        this.waiting.set(
          method,
          (this.waiting.get(method) ?? []).filter((each) => each !== settle),
        )
        resolve(undefined)
      }, timeoutMs)
    })
  }

  /**
   * Decide what happens to dialogs from now on.
   * @param policy - whether to accept, and what to type into a prompt.
   * @returns resolution once the page is answering prompts that way too.
   */
  async setDialogPolicy(policy: DialogPolicy): Promise<void> {
    this.policy = policy
    const target = this.debuggee()
    if (target === undefined || !target.isAttached()) return
    await this.installPrompt(target)
  }

  /** What the standing dialog policy is. */
  get dialogPolicy(): DialogPolicy {
    return this.policy
  }

  /**
   * Read and empty the console buffer.
   * @returns what the page logged since the last read.
   */
  takeConsole(): ConsoleEntry[] {
    return this.logged.splice(0)
  }

  /**
   * Read and empty the record of pages the browser moved to.
   *
   * Reported like a dialog, with whatever action was running when it
   * happened: a page that navigates under an automation run loses everything
   * typed into it, and a run that is not told cannot tell that from a step
   * that simply failed.
   * @returns the pages it moved to since the last read.
   */
  takeNavigations(): NavigationRecord[] {
    return this.navigated.splice(0)
  }

  /**
   * Read and empty the dialog buffer.
   * @returns the dialogs that opened since the last read, native ones and the
   *   prompts the page's substitute recorded.
   */
  async takeDialogs(): Promise<DialogRecord[]> {
    // A dialog is reported by the browser a moment after the click that
    // opened it returns, so draining immediately attributes it to the next
    // action instead of the one that caused it.
    await new Promise((resolve) => setTimeout(resolve, DIALOG_GRACE_MS))
    const native = this.opened.splice(0)
    const target = this.debuggee()
    if (target === undefined || !target.isAttached()) return native
    let prompts: { message: string; accepted: boolean }[] = []
    try {
      const answer = (await target.sendCommand('Runtime.evaluate', {
        expression: '(() => { const seen = window.__dshPrompts ?? []; window.__dshPrompts = []; return seen })()',
        returnByValue: true,
      })) as { result?: { value?: { message: string; accepted: boolean }[] } }
      prompts = answer.result?.value ?? []
    } catch {
      // The page navigated or closed while this was asked: whatever prompts
      // it had recorded went with it, and the native dialogs still stand.
      prompts = []
    }
    return [...native, ...prompts.map((each) => ({ kind: 'prompt', ...each }))]
  }
}
