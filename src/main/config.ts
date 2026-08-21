import { readFileSync } from 'node:fs'

/** Resolved desktop settings. `pnpmPath` pins the pnpm binary when PATH cannot find it. */
export interface DesktopConfig {
  harnessRepo: string
  notifyPort: number
  hotkey: string
  pnpmPath?: string
}

const DEFAULT_NOTIFY_PORT = 43117
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D'

/**
 * Read and validate `config.json`.
 * @param filePath - absolute path to the config file.
 * @returns the resolved settings with defaults applied.
 */
export function loadConfig(filePath: string): DesktopConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (cause) {
    throw new Error(`dsh-desktop: cannot read ${filePath}`, { cause })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`dsh-desktop: ${filePath} is not valid JSON`, { cause })
  }

  const record = parsed as Partial<DesktopConfig>
  if (typeof record.harnessRepo !== 'string' || record.harnessRepo === '') {
    throw new Error(`dsh-desktop: ${filePath} must set "harnessRepo" to the harness checkout path`)
  }

  return {
    harnessRepo: record.harnessRepo,
    notifyPort: record.notifyPort ?? DEFAULT_NOTIFY_PORT,
    hotkey: record.hotkey ?? DEFAULT_HOTKEY,
    ...(record.pnpmPath === undefined ? {} : { pnpmPath: record.pnpmPath }),
  }
}
