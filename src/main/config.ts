import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultSource, type HarnessSource } from './harness-source'

/** Resolved desktop settings. `pnpmPath`/`npxPath` pin binaries when PATH cannot find them. */
export interface DesktopConfig {
  harness: HarnessSource
  notifyPort: number
  hotkey: string
  pnpmPath?: string
  npxPath?: string
}

const DEFAULT_NOTIFY_PORT = 43117
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D'

/**
 * Read the desktop config, creating it with defaults on first run.
 * @param filePath - absolute path to `desktop.json`.
 * @param candidateRepo - checkout to prefer when writing a first-run default.
 * @returns the resolved settings.
 */
export function loadConfig(filePath: string, candidateRepo: string): DesktopConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    // ENOENT on first run: seed a config rather than failing to launch.
    const seeded: DesktopConfig = {
      harness: defaultSource(candidateRepo),
      notifyPort: DEFAULT_NOTIFY_PORT,
      hotkey: DEFAULT_HOTKEY,
    }
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${JSON.stringify(seeded, undefined, 2)}\n`)
    return seeded
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`dsh-desktop: ${filePath} is not valid JSON`, { cause })
  }

  const record = parsed as Partial<DesktopConfig>
  const harness = record.harness
  if (harness === undefined) {
    throw new Error(`dsh-desktop: ${filePath} must set "harness" to a local or npx source`)
  }
  if (harness.kind === 'local') {
    if (typeof harness.repo !== 'string' || harness.repo === '') {
      throw new Error(`dsh-desktop: ${filePath} local harness must set a non-empty "repo"`)
    }
  } else if (harness.kind === 'npx') {
    if (typeof harness.package !== 'string' || harness.package === '') {
      throw new Error(`dsh-desktop: ${filePath} npx harness must set a non-empty "package"`)
    }
  } else {
    throw new Error(`dsh-desktop: ${filePath} harness.kind must be "local" or "npx"`)
  }

  return {
    harness,
    notifyPort: record.notifyPort ?? DEFAULT_NOTIFY_PORT,
    hotkey: record.hotkey ?? DEFAULT_HOTKEY,
    ...(record.pnpmPath === undefined ? {} : { pnpmPath: record.pnpmPath }),
    ...(record.npxPath === undefined ? {} : { npxPath: record.npxPath }),
  }
}
