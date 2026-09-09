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

describe('tray app update', () => {
  function lastBuiltTemplate(): { label?: string; click?: () => void }[] {
    return menus[menus.length - 1]
  }

  it('renders a Restart-to-install row when an app update is set, wired to restartToInstall', () => {
    menus.length = 0
    const restartToInstall = vi.fn()
    const controller = createTray({ toggleWindow() {}, restart() {}, openSettings() {}, quit() {}, restartToInstall })
    controller.setAppUpdate('1.4.0')
    const template = lastBuiltTemplate()
    const row = template.find((item) => typeof item.label === 'string' && item.label.includes('Restart to install'))
    expect(row).toBeDefined()
    expect(row?.label).toContain('1.4.0')
    ;(row as { click: () => void }).click()
    expect(restartToInstall).toHaveBeenCalledTimes(1)
    controller.destroy()
  })

  it('drops the app-update row when set back to undefined', () => {
    menus.length = 0
    const controller = createTray({
      toggleWindow() {},
      restart() {},
      openSettings() {},
      quit() {},
      restartToInstall() {},
    })
    controller.setAppUpdate('1.4.0')
    controller.setAppUpdate(undefined)
    const template = lastBuiltTemplate()
    expect(template.find((i) => String(i.label).includes('Restart to install'))).toBeUndefined()
    controller.destroy()
  })
})
