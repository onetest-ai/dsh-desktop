import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessTheme, settingsPath } from './harness-theme'

/** A `$DSH_HOME` whose settings document holds the given text, or none at all. */
function home(settings?: string): string {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-theme-'))
  if (settings !== undefined) writeFileSync(settingsPath(dshHome), settings)
  return dshHome
}

describe('harnessTheme', () => {
  it.each([
    ['dark', 'ui-theme:\n  preference: dark\n'],
    ['light', 'ui-theme:\n  preference: light\n'],
    ['system', 'ui-theme:\n  preference: system\n'],
  ])('reads %s from the harness document', (expected, settings) => {
    expect(harnessTheme(home(settings))).toBe(expected)
  })

  it('reads it from a document holding every other section too', () => {
    const settings = 'ui-onboarding:\n  welcomeNoticeVersion: 1\nui-theme:\n  preference: dark\nagent-default-model:\n  provider: openai\n'
    expect(harnessTheme(home(settings))).toBe('dark')
  })

  // reason: `system` is what the harness itself shows in each of these, so a
  // surface that cannot read the file lands where the harness would.
  it.each([
    ['no document at all', undefined],
    ['text that is not YAML', ': : :'],
    ['a document that is a list', '- one\n- two\n'],
    ['no ui-theme section', 'ui-onboarding:\n  welcomeNoticeVersion: 1\n'],
    ['a ui-theme section that is not a map', 'ui-theme: dark\n'],
    ['a preference the harness does not define', 'ui-theme:\n  preference: solarized\n'],
    ['no preference field', 'ui-theme:\n  other: 1\n'],
  ])('falls back to system for %s', (_case, settings) => {
    expect(harnessTheme(home(settings))).toBe('system')
  })
})
