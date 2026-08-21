import { expect, test, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const APP_DIR = join(__dirname, '..', 'release', 'mac-arm64', 'DeepSeek Harness.app')
const APP = join(APP_DIR, 'Contents', 'MacOS', 'DeepSeek Harness')

/**
 * The path every harness child this app spawns receives as `--patch <path>`
 * (see `spawnFor` in `src/main/harness-source.ts`), in both local and npx
 * source modes. It is unique to this packaged app's own resource tree, so a
 * `pgrep -f` match on it cannot pick up a harness session the user launched
 * separately.
 */
const PATCH_MARKER = join(APP_DIR, 'Contents', 'Resources', 'app.asar.unpacked', 'desktop.patch.yml')

/**
 * Processes still carrying this app's `--patch` marker on their command line.
 * @returns `pgrep -fl` output for `PATCH_MARKER`, trimmed to '' when nothing matches.
 */
function findLeakedChildren(): string {
  try {
    return execFileSync('pgrep', ['-fl', PATCH_MARKER]).toString().trim()
  } catch (error) {
    // pgrep exits 1 when nothing matches, which is the passing case; any
    // other exit code is a real failure (e.g. bad pattern) and must surface.
    if ((error as { status?: number }).status === 1) return ''
    throw error
  }
}

test('launches, renders the harness UI, and leaves no orphans', async () => {
  const app = await electron.launch({ executablePath: APP })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded', { timeout: 90_000 })
  expect(window.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

  await app.close()
  await new Promise((r) => setTimeout(r, 2000))

  expect(findLeakedChildren()).toBe('')
})
