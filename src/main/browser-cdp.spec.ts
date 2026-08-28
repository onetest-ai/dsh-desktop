import { describe, expect, it, vi } from 'vitest'
import { BrowserSession, LOG_LIMIT, type Debuggee } from './browser-cdp'

/** A debugger that records what was sent and can replay protocol events. */
class FakeDebuggee implements Debuggee {
  attached = false
  readonly sent: { method: string; params?: object }[] = []
  private listener: ((event: unknown, method: string, params: Record<string, unknown>) => void) | undefined
  /** What `sendCommand` resolves to, by method. */
  replies: Record<string, unknown> = {}
  /** Methods that reject instead of resolving. */
  failures: Record<string, string> = {}

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  async sendCommand(method: string, params?: object): Promise<unknown> {
    this.sent.push({ method, params })
    const failure = this.failures[method]
    if (failure !== undefined) throw new Error(failure)
    return this.replies[method] ?? {}
  }

  on(_event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): void {
    this.listener = listener
  }

  /**
   * Deliver a protocol event, as the real debugger does.
   * @param method - the event's name.
   * @param params - its payload.
   */
  emit(method: string, params: Record<string, unknown>): void {
    this.listener?.(undefined, method, params)
  }
}

/**
 * A session over a fresh fake debugger.
 * @returns the session and the fake it drives.
 */
function session(): { browser: BrowserSession; fake: FakeDebuggee } {
  const fake = new FakeDebuggee()
  return { browser: new BrowserSession(() => fake), fake }
}

describe('BrowserSession', () => {
  // reason: the first thing a caller does may be to click something that
  // opens a dialog, and a dialog opening before `Page` is enabled is never
  // reported — it blocks the renderer instead, and with it everything after.
  it('finishes enabling the domains before the call that attached it runs', async () => {
    const { browser, fake } = session()
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed' })
    const enabled = fake.sent.findIndex((each) => each.method === 'Page.enable')
    const clicked = fake.sent.findIndex((each) => each.method === 'Input.dispatchMouseEvent')
    expect(enabled).toBeGreaterThanOrEqual(0)
    expect(enabled).toBeLessThan(clicked)
  })

  // reason: opening the developer tools takes the session, and a cached
  // attach that is no longer attached answers no dialogs — which blocks the
  // page and everything after it.
  it('attaches again after something else detached it', async () => {
    const { browser, fake } = session()
    await browser.send('Runtime.evaluate')
    fake.attached = false
    fake.sent.length = 0
    await browser.send('Runtime.evaluate')
    expect(fake.attached).toBe(true)
    expect(fake.sent.map((each) => each.method)).toContain('Page.enable')
  })

  it('does not attach again while it is still attached', async () => {
    const { browser, fake } = session()
    await browser.send('Runtime.evaluate')
    fake.sent.length = 0
    await browser.send('Runtime.evaluate')
    expect(fake.sent.map((each) => each.method)).not.toContain('Page.enable')
  })

  // reason: a page opens dialogs on its own — on load, on a timer — and one
  // that opens while nothing is attached is never answered.
  it('can be made ready before any tool asks', async () => {
    const { browser, fake } = session()
    await browser.ready()
    expect(fake.attached).toBe(true)
    expect(fake.sent.map((each) => each.method)).toContain('Page.enable')
  })

  it('says nothing when there is no browser to make ready', async () => {
    const browser = new BrowserSession(() => undefined)
    await expect(browser.ready()).resolves.toBeUndefined()
  })

  it('attaches once even when several calls arrive together', async () => {
    const { browser, fake } = session()
    await Promise.all([browser.send('Runtime.evaluate'), browser.send('Runtime.evaluate')])
    expect(fake.sent.filter((each) => each.method === 'Page.enable')).toHaveLength(1)
  })

  it('attaches once and enables the domains it listens to', async () => {
    const { browser, fake } = session()
    await browser.send('Runtime.evaluate', {})
    await browser.send('Runtime.evaluate', {})
    expect(fake.sent.filter((each) => each.method === 'Page.enable')).toHaveLength(1)
    expect(fake.sent.map((each) => each.method)).toContain('Log.enable')
  })

  it('reports there being no browser rather than throwing something opaque', async () => {
    const browser = new BrowserSession(() => undefined)
    await expect(browser.send('Runtime.evaluate')).rejects.toThrow('The browser is not open.')
  })

  describe('evaluate', () => {
    it('returns the value the page produced', async () => {
      const { browser, fake } = session()
      fake.replies['Runtime.evaluate'] = { result: { value: 42 } }
      expect(await browser.evaluate('40 + 2')).toEqual({ ok: true, value: 42 })
    })

    it('waits for a promise and returns it by value', async () => {
      const { browser, fake } = session()
      fake.replies['Runtime.evaluate'] = { result: { value: 'x' } }
      await browser.evaluate('Promise.resolve("x")')
      expect(fake.sent.at(-1)?.params).toMatchObject({ awaitPromise: true, returnByValue: true })
    })

    // reason: a thrown error arrives as a normal protocol reply, so a caller
    // that only checked for rejection would read it as a successful undefined.
    it('reports an error the page raised as a failure', async () => {
      const { browser, fake } = session()
      fake.replies['Runtime.evaluate'] = { exceptionDetails: { exception: { description: 'TypeError: nope' } } }
      expect(await browser.evaluate('boom()')).toEqual({ ok: false, reason: 'TypeError: nope' })
    })

    it('reports a protocol failure as a failure', async () => {
      const { browser, fake } = session()
      fake.failures['Runtime.evaluate'] = 'target closed'
      expect(await browser.evaluate('1')).toEqual({ ok: false, reason: 'target closed' })
    })
  })

  describe('the console', () => {
    it('keeps what the page logged, and empties on read', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'careful' }] })
      expect(browser.takeConsole()).toEqual([{ level: 'warning', text: 'careful' }])
      expect(browser.takeConsole()).toEqual([])
    })

    it('keeps an uncaught exception, which is what a JS error looks like', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.emit('Runtime.exceptionThrown', {
        exceptionDetails: { exception: { description: 'TypeError: Lr.findDOMNode is not a function' } },
      })
      expect(browser.takeConsole()).toEqual([
        { level: 'error', text: 'TypeError: Lr.findDOMNode is not a function' },
      ])
    })

    it('keeps a browser log entry, which is where a failed request lands', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.emit('Log.entryAdded', { entry: { level: 'error', text: '404 on /missing.js' } })
      expect(browser.takeConsole()).toEqual([{ level: 'error', text: '404 on /missing.js' }])
    })

    it('drops the oldest past the limit rather than growing without bound', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      for (let index = 0; index < LOG_LIMIT + 10; index += 1) {
        fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: String(index) }] })
      }
      const kept = browser.takeConsole()
      expect(kept).toHaveLength(LOG_LIMIT)
      expect(kept.at(-1)?.text).toBe(String(LOG_LIMIT + 9))
    })
  })

  describe('navigation', () => {
    // reason: a page that navigates under an automation run loses everything
    // typed into it, and a run that is not told cannot tell that from a step
    // that simply failed.
    it('records where the browser went, and empties on read', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.emit('Page.frameNavigated', { frame: { url: 'https://demoqa.com/alerts' } })
      expect(browser.takeNavigations()).toEqual([{ url: 'https://demoqa.com/alerts' }])
      expect(browser.takeNavigations()).toEqual([])
    })

    // reason: a page's adverts navigate their own frames constantly, and none
    // of that moves the page the model is reading.
    it('ignores a frame inside the page', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.emit('Page.frameNavigated', { frame: { url: 'https://ads.example/x', parentId: 'main' } })
      expect(browser.takeNavigations()).toEqual([])
    })
  })

  describe('dialogs', () => {
    it('dismisses by default, so a page is never left blocked', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' })
      expect(fake.sent.at(-1)).toEqual({
        method: 'Page.handleJavaScriptDialog',
        params: { accept: false, promptText: undefined },
      })
    })

    it('accepts, with prompt text, once told to', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      await browser.setDialogPolicy({ accept: true, promptText: 'Olha' })
      fake.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Your name?' })
      expect(fake.sent.at(-1)?.params).toEqual({ accept: true, promptText: 'Olha' })
    })

    // reason: the page can navigate out from under a dialog before the reply
    // lands, and the rejection that follows is not a reason to bring the app
    // down.
    it('survives a dialog that has already closed', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.failures['Page.handleJavaScriptDialog'] = 'No dialog is showing'
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      process.off('unhandledRejection', unhandled)
      expect(unhandled).not.toHaveBeenCalled()
      expect(await browser.takeDialogs()).toHaveLength(1)
    })

    // reason: Electron does not implement `prompt` — it throws before any
    // dialog exists, so there is nothing for the protocol to intercept and a
    // page that calls it fails outright.
    it('gives the page a prompt of its own, for now and for later pages', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      const installs = fake.sent.filter((each) => each.method === 'Page.addScriptToEvaluateOnNewDocument')
      expect(installs).toHaveLength(1)
      expect((installs[0].params as { source: string }).source).toContain('window.prompt =')
    })

    it('reinstalls its prompt when the policy changes, so it answers the new way', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      await browser.setDialogPolicy({ accept: true, promptText: 'Olha' })
      const source = (fake.sent
        .filter((each) => each.method === 'Page.addScriptToEvaluateOnNewDocument')
        .at(-1)?.params as { source: string }).source
      expect(source).toContain('"Olha"')
      expect(source).toContain('accept: true')
    })

    it('does not reinstall its prompt when nothing about the policy changed', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      await browser.setDialogPolicy({ accept: false })
      expect(fake.sent.filter((each) => each.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1)
    })

    it('reports the prompts the page recorded alongside the native dialogs', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' })
      fake.replies['Runtime.evaluate'] = { result: { value: [{ message: 'Please enter your name', accepted: true }] } }
      expect(await browser.takeDialogs()).toEqual([
        { kind: 'alert', message: 'hi', accepted: false },
        { kind: 'prompt', message: 'Please enter your name', accepted: true },
      ])
    })

    it('records what appeared and how it was answered', async () => {
      const { browser, fake } = session()
      await browser.send('Runtime.evaluate')
      await browser.setDialogPolicy({ accept: true })
      fake.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Do you confirm action?' })
      expect(await browser.takeDialogs()).toEqual([
        { kind: 'confirm', message: 'Do you confirm action?', accepted: true },
      ])
      expect(await browser.takeDialogs()).toEqual([])
    })
  })
})
