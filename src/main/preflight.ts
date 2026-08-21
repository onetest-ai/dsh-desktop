import { statSync } from 'node:fs'
import { join } from 'node:path'

/** Whether the harness checkout is usable, or why it is not. */
export type PreflightResult = { ok: true } | { ok: false; message: string }

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // statSync throws ENOENT for a missing path; absence is the answer, not an error.
    return false
  }
}

/**
 * Check that the harness checkout exists and its frontend has been built.
 * A pulled-but-unbuilt checkout serves an empty page, so the missing
 * `apps/web/dist` is reported as a build instruction rather than a blank window.
 * @param harnessRepo - absolute path to the harness checkout.
 * @returns ok, or a message naming the exact remedy.
 */
export function preflight(harnessRepo: string): PreflightResult {
  if (!isDirectory(harnessRepo)) {
    return { ok: false, message: `Harness checkout not found at ${harnessRepo}. Fix "harnessRepo" in config.json.` }
  }
  if (!isDirectory(join(harnessRepo, 'apps', 'web', 'dist'))) {
    return {
      ok: false,
      message: `The harness frontend is not built. Run "pnpm run build:web" in ${harnessRepo}.`,
    }
  }
  return { ok: true }
}
