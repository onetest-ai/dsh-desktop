import { expect, test, _electron as electron } from '@playwright/test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const APP = join(__dirname, '..', 'release', 'mac-arm64', 'DeepSeek Harness.app',
  'Contents', 'MacOS', 'DeepSeek Harness')

test('launches, renders the harness UI, and leaves no orphans', async () => {
  const app = await electron.launch({ executablePath: APP })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded', { timeout: 90_000 })
  expect(window.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

  await app.close()
  await new Promise((r) => setTimeout(r, 2000))

  const survivors = (() => {
    try {
      return execSync('pgrep -fl "dsh web" || true').toString().trim()
    } catch {
      // pgrep exits non-zero when nothing matches, which is the passing case.
      return ''
    }
  })()
  expect(survivors).toBe('')
})
