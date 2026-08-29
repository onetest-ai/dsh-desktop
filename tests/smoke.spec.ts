import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_DIR = join(__dirname, '..', 'release', 'mac-arm64', 'DeepSeek Harness.app')

/**
 * The pty helper inside the packaged app.
 *
 * node-pty spawns this binary for every terminal, and its published tarball
 * ships it without the executable bit. electron-builder copies the mode it
 * finds and a signed bundle cannot be repaired afterwards, so the packaged
 * artifact is the only place worth asserting it.
 */
const SPAWN_HELPER = join(
  APP_DIR,
  'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty',
  'prebuilds', 'darwin-arm64', 'spawn-helper',
)
const APP = join(APP_DIR, 'Contents', 'MacOS', 'DeepSeek Harness')

/**
 * The harness checkout this test points the packaged app at.
 *
 * `dsh-desktop` and `deepseek-harness` are sibling checkouts under the same
 * parent directory (see `docs/superpowers/plans/2026-08-21-dsh-desktop.md`),
 * so the path is derived from this test file's own location rather than
 * hardcoded, keeping it portable across machines that follow that layout.
 */
const HARNESS_REPO = join(__dirname, '..', '..', 'deepseek-harness')

/**
 * Wait for one of the app's windows to be showing a matching URL.
 *
 * The app has two windows with different lifetimes — a splash that is
 * destroyed and a main window that outlives it — so a window is found by what
 * it is showing rather than by `firstWindow()`, which resolves to whichever
 * one Electron happened to create first.
 * @param app - the launched Electron application.
 * @param pattern - the URL to wait for.
 * @returns the matching page.
 */
async function waitForWindowUrl(app: ElectronApplication, pattern: RegExp): Promise<Page> {
  const deadline = Date.now() + 90_000
  for (;;) {
    const match = app.windows().find((page) => pattern.test(page.url()))
    if (match !== undefined) return match
    if (Date.now() > deadline) {
      throw new Error(`no window matched ${pattern}; open windows: ${app.windows().map((page) => page.url()).join(', ') || '(none)'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * Build a `desktop.json` pointing at a local harness checkout, in a fresh
 * `$DSH_HOME` this test owns.
 *
 * Without this, the app falls back to the developer's real `~/.dsh`: on a
 * machine where that directory has been cleared for a first-run test, the
 * app correctly opens Settings instead of booting a harness, and the test
 * times out waiting for a `127.0.0.1` URL. Provisioning `$DSH_HOME` here
 * makes the test depend on nothing about the machine's real state, so it
 * passes whether or not `~/.dsh` exists.
 * @returns the `$DSH_HOME` directory this run should use.
 */
function provisionDshHome(): string {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-home-'))
  const config = {
    harness: { kind: 'local', repo: HARNESS_REPO },
    pnpmPath: execFileSync('which', ['pnpm']).toString().trim(),
  }
  writeFileSync(join(dshHome, 'desktop.json'), `${JSON.stringify(config, undefined, 2)}\n`)
  return dshHome
}

/**
 * Processes still carrying this app's `--patch` marker on their command line.
 *
 * The marker is the generated overlay's path, which every harness child this
 * app spawns receives as `--patch <path>` (see `spawnFor` in
 * `src/main/harness-source.ts`) in both local and managed source modes. It is
 * unique to this app's own `userData` directory, so a `pgrep -f` match on it
 * cannot pick up a harness session the user launched separately. It is read
 * from the running app rather than reconstructed here, so the check cannot
 * quietly go vacuous if the generated location moves.
 * @param marker - the `--patch` path the app passes its children.
 * @returns `pgrep -fl` output for the marker, trimmed to '' when nothing matches.
 */
function findLeakedChildren(marker: string): string {
  try {
    return execFileSync('pgrep', ['-fl', marker]).toString().trim()
  } catch (error) {
    // pgrep exits 1 when nothing matches, which is the passing case; any
    // other exit code is a real failure (e.g. bad pattern) and must surface.
    if ((error as { status?: number }).status === 1) return ''
    throw error
  }
}

// Playwright's 30s default covers none of this: a cold launch builds the
// harness overlay, boots a child, and may install a missing plugin first.
test.setTimeout(180_000)

test('launches, renders the harness UI, and leaves no orphans', async () => {
  // Its own user-data directory, for two reasons: Electron's single-instance
  // lock is keyed on that path, so without this the test fails outright
  // whenever the developer has the app open; and the runtime files the app
  // generates land there, keeping the real installation untouched.
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const dshHome = provisionDshHome()
  const app = await electron.launch({
    executablePath: APP,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DSH_HOME: dshHome },
  })
  let marker: string
  try {
    const userData: string = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    marker = join(userData, 'runtime', 'desktop.patch.yml')
    // The splash is what appears first: it checks the install and repairs what
    // is missing before the harness boots, so the harness window arrives
    // afterwards rather than immediately. All three halves are pinned — that
    // the splash appears, that the harness window follows, and that the splash
    // then goes away rather than being left behind as a frameless window with
    // no close button.
    const splash = await waitForWindowUrl(app, /startup\.html$/)
    const window = await waitForWindowUrl(app, /^http:\/\/127\.0\.0\.1:\d+/)
    await window.waitForLoadState('domcontentloaded', { timeout: 90_000 })
    // Asked of the main process rather than of Playwright's page handle: the
    // splash is destroyed, and what matters is that no window is left holding
    // it, not how the driver reports that page.
    // reason: the window is created hidden and no longer shows itself on
    // `ready-to-show` — that event belongs to the divider page, which loads
    // immediately. Only the harness view finishing a load may reveal it.
    await expect
      .poll(
        async () =>
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some((each) => each.getContentSize()[0] > 800 && each.isVisible()),
          ),
        { timeout: 30_000 },
      )
      .toBe(true)

    // The pane starts closed, so the harness view has the whole window: its
    // width is the window's own, not a fraction of it.
    // Harness, editor, files, terminal, web. With every column closed the
    // harness has everything except the rail at the edge, and nothing else
    // has width.
    const closed = await app.evaluate(({ BrowserWindow }) => {
      const [main] = BrowserWindow.getAllWindows().filter((each) => each.getContentSize()[0] > 800)
      const [width] = main.getContentSize()
      const widths = main.contentView.children.map((child) => child.getBounds().width)
      return { widths, width }
    })
    expect(closed.widths[0]).toBeGreaterThan(closed.width - 60)
    expect(closed.widths[0]).toBeLessThan(closed.width)
    expect(closed.widths.slice(1)).toEqual([0, 0, 0, 0])

    await expect
      .poll(
        async () =>
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((each) => each.webContents.getURL()),
          ),
        { timeout: 30_000 },
      )
      .not.toContain(splash.url())

    // Asked of the Electron main process, whose fs understands app.asar.
    // getAppPath() already resolves to the app.asar path on this build (verified
    // by printing it during development), so it is used directly rather than
    // the dirname(...)/app.asar wrapping the brief describes as a fallback.
    const appPath: string = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath())
    // The whole point of this check is reading through app.asar rather than a
    // plain directory; assert that assumption explicitly so a future Electron
    // version, platform, or unpacked build fails loudly here instead of
    // silently checking the wrong location (and reporting a false pass).
    expect(appPath, `expected getAppPath() to resolve inside app.asar, got: ${appPath}`).toMatch(
      /app\.asar$/,
    )

    // The preset catalog is data now, not a TypeScript constant, so nothing
    // at compile time proves it reaches the package. A missing catalog would
    // otherwise ship as an app with an empty picker and no error anywhere.
    const presets = await app.evaluate(({ app: electronApp }) => {
      const { existsSync, readFileSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      const file = join(electronApp.getAppPath(), 'assets', 'mcp-presets.json')
      if (!existsSync(file)) return { present: false, count: 0 }
      return { present: true, count: ((JSON.parse(readFileSync(file, 'utf8')) as { presets?: unknown[] }).presets ?? []).length }
    })
    expect(presets.present, 'assets/mcp-presets.json is missing from the package').toBe(true)
    expect(presets.count).toBeGreaterThan(0)

    const shipped = await app.evaluate(({ app: electronApp }) => {
      const { existsSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      const dist = join(electronApp.getAppPath(), 'dist')
      return {
        preload: existsSync(join(dist, 'preload', 'settings.js')),
        renderer: existsSync(join(dist, 'renderer', 'settings.html')),
        // The startup surface is copied by its own step in build:renderer,
        // and a renderer file missing from that step produces no compile
        // error — the failure class this whole assertion exists for.
        startup:
          existsSync(join(dist, 'renderer', 'startup.html')) &&
          existsSync(join(dist, 'renderer', 'startup.js')) &&
          existsSync(join(dist, 'renderer', 'splash.css')) &&
          existsSync(join(dist, 'renderer', 'shell.html')) &&
          existsSync(join(dist, 'renderer', 'pane.html')) &&
          existsSync(join(dist, 'renderer', 'pane-bundle.js')) &&
          existsSync(join(dist, 'renderer', 'files.html')) &&
          existsSync(join(dist, 'renderer', 'files-bundle.js')) &&
          existsSync(join(dist, 'renderer', 'ts.worker.js')) &&
          existsSync(join(dist, 'preload', 'pane.js')) &&
          existsSync(join(dist, 'renderer', 'splash.png')) &&
          existsSync(join(dist, 'preload', 'startup.js')),
      }
    })
    expect(shipped).toEqual({ preload: true, renderer: true, startup: true })
  } finally {
    // Every assertion above sits between launch and close, and one of them —
    // the app.asar path check — is written to fail on a future Electron or
    // platform. Without this the failing run would leave the app, its harness
    // child, and the node-pty grandchildren alive: exactly the leak the final
    // assertion exists to catch.
    await app.close()
  }
  await new Promise((r) => setTimeout(r, 2000))

  expect(findLeakedChildren(marker)).toBe('')
})

/**
 * The panel comes back with a shell in it after its last tab is closed.
 *
 * Driven through the packaged app because the failure lived entirely in the
 * renderer, which starts its shell once at page load: every unit test of the
 * main process passed while the panel came back as a strip of chrome with
 * nothing in it.
 */
test('reopens the terminal panel with a shell in it', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-'))
  const dshHome = provisionDshHome()
  const app = await electron.launch({
    executablePath: APP,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DSH_HOME: dshHome },
  })
  try {
    const shell = await waitForWindowUrl(app, /shell\.html$/)
    const panel = await waitForWindowUrl(app, /terminal\.html$/)

    // Opened from the rail, the way it is opened in the app.
    await shell.click('#rail-terminal')
    await expect.poll(async () => await panel.locator('.terminal-tab').count(), { timeout: 30_000 }).toBe(1)

    // Closing the only tab takes the panel with it.
    await panel.click('.terminal-tab-close')
    await expect.poll(async () => await panel.locator('.terminal-tab').count(), { timeout: 15_000 }).toBe(0)

    // Reopening must start a shell rather than showing the empty strip: the
    // page has already run, so nothing else would.
    await shell.click('#rail-terminal')
    await expect.poll(async () => await panel.locator('.terminal-tab').count(), { timeout: 30_000 }).toBe(1)
  } finally {
    await app.close()
  }
})

/**
 * The seam beside the browser column is the thing that resizes it.
 *
 * A divider is not a view: it is the window's own page showing through an 8px
 * gap the views leave. Nothing in the layout arithmetic proves the gap is
 * actually reachable — a view laid a few pixels over it looks identical and
 * swallows every drag — so this grabs the seam in the running app and checks
 * the column moved. Fullscreen is covered because the window resizes by
 * animation there, which is where a stale divider place would show up.
 */
test('resizes the browser column by dragging its seam', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-divider-'))
  const dshHome = provisionDshHome()
  const app = await electron.launch({
    executablePath: APP,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, DSH_HOME: dshHome },
  })

  /**
   * The editor column's bounds, as the main process has them.
   * @returns the pane view's bounds.
   */
  const editorBounds = async (): Promise<{ x: number; width: number }> =>
    await app.evaluate(({ BrowserWindow }) => {
      const [main] = BrowserWindow.getAllWindows().filter((each) => each.getContentSize()[0] > 800)
      const [, pane] = main.contentView.children
      return { x: pane.getBounds().x, width: pane.getBounds().width }
    })

  try {
    const shell = await waitForWindowUrl(app, /shell\.html$/)
    await shell.click('#rail-web')
    await expect.poll(async () => (await editorBounds()).width, { timeout: 30_000 }).toBeGreaterThan(0)

    for (const fullScreen of [false, true]) {
      if (fullScreen) {
        await app.evaluate(({ BrowserWindow }) => {
          const [main] = BrowserWindow.getAllWindows().filter((each) => each.getContentSize()[0] > 800)
          main.setFullScreen(true)
        })
        await expect
          .poll(async () => await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some((each) => each.isFullScreen())), { timeout: 30_000 })
          .toBe(true)
      }

      // The grab target must sit exactly where the column starts, or someone
      // aiming at the seam they can see grabs nothing.
      const before = await editorBounds()
      const seam = await shell.locator('#divider-editor').boundingBox()
      expect(seam, 'the editor divider has no box to grab').not.toBeNull()
      expect(seam!.x + seam!.width, `divider is not against the column${fullScreen ? ' in fullscreen' : ''}`).toBe(before.x)

      await shell.mouse.move(seam!.x + seam!.width / 2, seam!.y + 200)
      await shell.mouse.down()
      await shell.mouse.move(seam!.x + seam!.width / 2 - 200, seam!.y + 200, { steps: 10 })
      await shell.mouse.up()

      await expect
        .poll(async () => (await editorBounds()).width, { timeout: 15_000 })
        .toBeGreaterThan(before.width + 100)
    }
  } finally {
    await app.close()
  }
})

// reason: without the executable bit every terminal fails with a bare
// `posix_spawnp failed.`, and the mode npm leaves it in is not executable.
test('ships a pty helper the app may actually execute', () => {
  expect(existsSync(SPAWN_HELPER), `${SPAWN_HELPER} is missing from the packaged app`).toBe(true)
  expect(statSync(SPAWN_HELPER).mode & 0o111, 'spawn-helper is not executable').not.toBe(0)
})
