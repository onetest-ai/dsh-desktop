// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(import.meta.dirname)
const VENDOR = join(import.meta.dirname, '..', '..', 'vendor', 'dsh-theme')

/**
 * The selectors a stylesheet declares a given custom property under.
 * @param css - the stylesheet's text.
 * @param property - the custom property, without its leading dashes.
 * @returns every selector whose block declares it.
 */
function declaredUnder(css: string, property: string): string[] {
  const found: string[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (new RegExp(`(^|[;\\s])--${property}\\s*:`).test(match[2])) found.push(match[1].trim().split('\n').pop() ?? '')
  }
  return found
}

describe('the vendored token sheet', () => {
  // reason: everything below depends on where upstream puts the aliases, and
  // upstream is re-vendored from a package this repo does not control.
  it('defines its aliases on body, not on the root element', () => {
    const css = readFileSync(join(VENDOR, 'design-platform.css'), 'utf8')
    const selectors = declaredUnder(css, 'dsw-alias-bg-base')
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selector).toMatch(/^body/)
  })
})

describe('every page that maps those aliases', () => {
  const sheets = readdirSync(RENDERER)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name, css: readFileSync(join(RENDERER, name), 'utf8') }))
    .filter((sheet) => sheet.css.includes('--dsw-alias-'))

  it('finds the stylesheets to check', () => {
    expect(sheets.length).toBeGreaterThan(0)
  })

  // reason: custom properties inherit downwards only. The vendored sheet
  // defines every alias on `body`, so a page mapping them on `:root` — one
  // level up — resolves all of them to nothing: the window paints Electron's
  // white, and anything with a token background turns transparent. Settings
  // shipped exactly that.
  it.each(sheets.map((sheet) => sheet.name))('reads them at body or below, never at :root (%s)', (name) => {
    const css = sheets.find((sheet) => sheet.name === name)?.css ?? ''
    const offending: string[] = []
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = (match[1].trim().split('\n').pop() ?? '').trim()
      if (!/^:root\b/.test(selector)) continue
      if (match[2].includes('--dsw-alias-')) offending.push(selector)
    }
    expect(offending).toEqual([])
  })
})
