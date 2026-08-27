import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** What the harness's Appearance row stores. */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * The harness's own user-settings document.
 *
 * Read, never written: the preference belongs to the harness's Appearance
 * row, and this app follows it rather than offering a second control for the
 * same thing.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute `settings.yaml` path.
 */
export function settingsPath(dshHome: string): string {
  return join(dshHome, 'settings.yaml')
}

/**
 * Read the theme the harness is set to.
 *
 * `system` when the document is missing, unreadable, or says anything else —
 * the same default the harness itself applies, so a surface that cannot read
 * the file lands where the harness would have put it anyway.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the stored preference.
 */
export function harnessTheme(dshHome: string): ThemePreference {
  let parsed: unknown
  try {
    parsed = load(readFileSync(settingsPath(dshHome), 'utf8'))
  } catch {
    // No settings document yet, or one this app may not read: `system` is
    // what the harness shows in both cases.
    return 'system'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'system'
  const section = (parsed as Record<string, unknown>)['ui-theme']
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return 'system'
  const preference = (section as Record<string, unknown>).preference
  return preference === 'light' || preference === 'dark' ? preference : 'system'
}
