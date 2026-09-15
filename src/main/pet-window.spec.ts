import { describe, expect, it, vi } from 'vitest'

/** One fake pet BrowserWindow, recording the order of the calls we care about. */
const { order, dockShow, fakeWindow } = vi.hoisted(() => {
  const order: string[] = []
  const dockShow = vi.fn(() => order.push('dock:show'))
  const fakeWindow = {
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(() => order.push('viz')),
    once: vi.fn(),
    showInactive: vi.fn(),
    loadURL: vi.fn(),
  }
  return { order, dockShow, fakeWindow }
})
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(() => fakeWindow),
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
  app: { dock: { show: dockShow } },
}))

import { createPetWindow, petComposePanelSize, petWindowSize } from './pet-window'

describe('createPetWindow', () => {
  it('restores the app dock icon after making the pet visible on all workspaces', () => {
    // `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` flips the
    // whole app to an accessory (no Dock icon); the pet must not cost the app
    // its Dock tile, so the dock is shown again right after — and only after,
    // since showing it before the flip would be undone by the flip.
    order.length = 0
    dockShow.mockClear()
    createPetWindow({ scale: 1, deps: { preloadPath: '/pre.js', paneOrigin: 'app://pane' } })
    expect(dockShow).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['viz', 'dock:show'])
  })
})

describe('petWindowSize', () => {
  it('scales the 192x208 frame plus the bubble band above it, and adds the fixed controls-row height', () => {
    expect(petWindowSize(1)).toEqual({ width: 192, height: 348 })
    expect(petWindowSize(1.5)).toEqual({ width: 288, height: 500 })
  })

  it('floors width at the controls-row minimum when the sprite is scaled down small', () => {
    expect(petWindowSize(0.25)).toEqual({ width: 96, height: 120 })
  })
})

describe('petComposePanelSize', () => {
  it('floors width at the panel minimum and swaps the controls-row band for the panel band, at the default scale', () => {
    expect(petComposePanelSize(1)).toEqual({ width: 380, height: 500 })
  })

  it('floors width at the panel minimum when the sprite is scaled down small', () => {
    expect(petComposePanelSize(0.5)).toEqual({ width: 380, height: 348 })
  })

  it('leaves width alone once the scaled sprite is already wider than the floor, replacing the controls-row band with the panel band in height', () => {
    expect(petComposePanelSize(2)).toEqual({ width: 384, height: 804 })
  })

  it('replaces the controls row rather than adding to it: at every scale the panel height equals the sprite region plus the panel band alone', () => {
    for (const scale of [0.5, 1, 1.5, 2]) {
      const sprite = petWindowSize(scale).height - 44 // CONTROLS_ROW_H, mirrored by hand
      expect(petComposePanelSize(scale).height).toBe(sprite + 196) // COMPOSE_PANEL_H, mirrored by hand
    }
  })
})
