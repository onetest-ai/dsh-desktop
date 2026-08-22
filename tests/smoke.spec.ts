import { mkdtempSync, writeFileSync } from 'node:fs'
import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_DIR = join(__dirname, '..', 'release', 'mac-arm64', 'DeepSeek Harness.app')
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
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded', { timeout: 90_000 })
    expect(window.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

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

    const shipped = await app.evaluate(({ app: electronApp }) => {
      const { existsSync } = process.getBuiltinModule('node:fs')
      const { join } = process.getBuiltinModule('node:path')
      const dist = join(electronApp.getAppPath(), 'dist')
      return {
        preload: existsSync(join(dist, 'preload', 'settings.js')),
        renderer: existsSync(join(dist, 'renderer', 'settings.html')),
      }
    })
    expect(shipped).toEqual({ preload: true, renderer: true })
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
