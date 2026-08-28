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
  private listening = false
  private readonly waiting = new Map<string, ((params: Record<string, unknown>) => void)[]>()

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
  private attached(): Debuggee {
    const target = this.debuggee()
    if (target === undefined) throw new Error('The browser is not open.')
    if (!this.listening) {
      target.on('message', (_event, method, params) => {
        this.record(method, params)
      })
      this.listening = true
    }
    if (!target.isAttached()) {
      target.attach('1.3')
      // Enabled here rather than lazily: a page logs and opens dialogs
      // whether or not anyone has asked yet, and a domain enabled after the
      // fact reports nothing that already happened.
      for (const domain of ['Page', 'Runtime', 'Log']) void target.sendCommand(`${domain}.enable`)
    }
    return target
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
   * Send one protocol command.
   * @param method - the command's name.
   * @param params - its parameters.
   * @returns what the command returned.
   */
  async send<T>(method: string, params?: object): Promise<T> {
    return (await this.attached().sendCommand(method, params)) as T
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
   */
  setDialogPolicy(policy: DialogPolicy): void {
    this.policy = policy
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
   * Read and empty the dialog buffer.
   * @returns the dialogs that opened since the last read.
   */
  takeDialogs(): DialogRecord[] {
    return this.opened.splice(0)
  }
}
