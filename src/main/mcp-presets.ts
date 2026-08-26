import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One offered MCP server.
 *
 * `unavailable`, when set, is why the preset cannot be added yet — an OAuth-
 * only server issues no credential this app can carry. Such a preset is still
 * listed: a user looking for Linear should learn it is known and unsupported,
 * not be left wondering whether they typed the name wrong.
 */
export interface McpPreset {
  id: string
  label: string
  docs?: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  auth?: 'token' | 'oauth'
  tokenLabel?: string
  unavailable?: string
}

/**
 * The catalog shipped inside the app bundle.
 *
 * Resolved relative to this module the same way `settings-window.ts` reaches
 * the renderer, so it works from `dist/` and from inside `app.asar` alike.
 * `assets/**` is already in electron-builder's `files`, so the catalog ships
 * with no build step of its own — and, because nothing type-checks it any
 * more, `tests/smoke.spec.ts` asserts it is actually in the package.
 * @returns the absolute path of the shipped catalog.
 */
export function shippedPresetsPath(): string {
  return join(__dirname, '..', '..', 'assets', 'mcp-presets.json')
}

/**
 * The optional per-machine catalog, merged over the shipped one.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute path of the user's catalog.
 */
export function userPresetsPath(dshHome: string): string {
  return join(dshHome, 'mcp-presets.json')
}

/**
 * Validate one catalog entry.
 *
 * An entry that names no usable transport is dropped rather than repaired:
 * a preset that cannot be added is worse than a preset that is absent,
 * because it appears in the picker and then fails.
 * @param raw - the candidate, from untrusted JSON.
 * @returns the preset, or undefined when it is unusable.
 */
function validate(raw: unknown): McpPreset | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const preset = raw as Partial<McpPreset>
  if (typeof preset.id !== 'string' || preset.id === '') return undefined
  if (typeof preset.label !== 'string' || preset.label === '') return undefined
  if (preset.transport === 'stdio') {
    if (typeof preset.command !== 'string' || preset.command === '') return undefined
  } else if (preset.transport === 'http') {
    if (typeof preset.url !== 'string' || !preset.url.startsWith('https://')) return undefined
  } else {
    return undefined
  }
  return preset as McpPreset
}

/**
 * Read one catalog file.
 *
 * A missing, unreadable, or malformed file yields no presets: the catalog is
 * a convenience, and a broken one must cost the user their preset list rather
 * than the ability to start.
 * @param file - the catalog path.
 * @returns the valid presets it declares.
 */
function readCatalog(file: string): McpPreset[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const presets = (parsed as { presets?: unknown }).presets
  if (!Array.isArray(presets)) return []
  const valid: McpPreset[] = []
  for (const raw of presets) {
    const preset = validate(raw)
    if (preset !== undefined) valid.push(preset)
  }
  return valid
}

/**
 * The catalog to offer: the shipped presets, with the user's own merged over
 * them by id.
 *
 * The user file is what makes the catalog updatable without an app release —
 * correcting a vendor's endpoint, or handing a team its own internal servers.
 * A preset names a command to run, so that file carries exactly the trust its
 * own user already has over `mcp.json`, which they can edit by hand anyway.
 * This is also why no catalog is ever fetched over the network: the same data
 * arriving from a URL would be arbitrary code execution at app start.
 * @param shippedFile - the catalog inside the bundle.
 * @param userFile - the per-machine catalog, usually absent.
 * @returns the presets to offer, shipped order first.
 */
export function loadPresets(shippedFile: string, userFile: string): McpPreset[] {
  const merged = new Map<string, McpPreset>()
  for (const preset of readCatalog(shippedFile)) merged.set(preset.id, preset)
  for (const preset of readCatalog(userFile)) merged.set(preset.id, preset)
  return [...merged.values()]
}
