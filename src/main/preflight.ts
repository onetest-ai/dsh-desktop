import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessSource } from './harness-source'

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
 * Check that a local harness checkout exists and its frontend has been built.
 * An npx source has no checkout to validate: the published package ships its
 * own built frontend, so npx availability is reported by the spawn failure
 * instead.
 * A pulled-but-unbuilt checkout serves an empty page, so the missing
 * `apps/web/dist` is reported as a build instruction rather than a blank window.
 * @param source - the configured harness source.
 * @returns ok, or a message naming the exact remedy.
 */
export function preflight(source: HarnessSource): PreflightResult {
  if (source.kind === 'npx') {
    return { ok: true }
  }
  if (!isDirectory(source.repo)) {
    return {
      ok: false,
      message: `Harness checkout not found at ${source.repo}. Fix "harness.repo" in desktop.json.`,
    }
  }
  if (!isDirectory(join(source.repo, 'apps', 'web', 'dist'))) {
    return {
      ok: false,
      message: `The harness frontend is not built. Run "pnpm run build:web" in ${source.repo}.`,
    }
  }
  return { ok: true }
}
