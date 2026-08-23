import { describe, expect, it, vi } from 'vitest'

const menus: { label?: string }[][] = []
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (t: { label?: string }[]) => { menus.push(t); return t } },
  Tray: class {
    setImage(): void {}
    setToolTip(): void {}
    setContextMenu(): void {}
    destroy(): void {}
  },
  nativeImage: { createFromPath: () => ({ setTemplateImage(): void {} }) },
}))

const { createTray } = await import('./tray')

const actions = { toggleWindow: () => {}, restart: () => {}, openSettings: () => {}, quit: () => {} }

describe('tray note', () => {
  it('never renders a menu label long enough to distort the menu', () => {
    menus.length = 0
    const tray = createTray(actions)
    // A harness error with a stack trace is thousands of characters; a menu
    // item draws its label on one unwrapped line.
    tray.setStatus('running', 'x'.repeat(5000))
    const labels = menus.flat().map((item) => item.label ?? '')
    expect(Math.max(...labels.map((label) => label.length))).toBeLessThanOrEqual(80)
    tray.destroy()
  })

  it('passes a short note through unchanged', () => {
    menus.length = 0
    const tray = createTray(actions)
    tray.setStatus('running', '@onetest/dsh-deck disabled — see Settings for why')
    expect(menus.flat().some((item) => item.label === '@onetest/dsh-deck disabled — see Settings for why')).toBe(true)
    tray.destroy()
  })
})
