import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PaneButton } from './PaneButton.tsx'

afterEach(() => {
  cleanup()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

/** Put a desktop bridge on the page, as that app's preload does. */
function bridged(): { toggleFiles: ReturnType<typeof vi.fn>; toggleWeb: ReturnType<typeof vi.fn> } {
  const bridge = { toggleFiles: vi.fn(), toggleWeb: vi.fn() }
  ;(globalThis as { dshDesktop?: unknown }).dshDesktop = bridge
  return bridge
}

describe('PaneButton', () => {
  // reason: the browser half is bundled once and served to whatever page
  // loads it. In a plain browser there are no panels, so buttons offering to
  // toggle them would do nothing when clicked.
  it('renders nothing outside the desktop app', () => {
    const { container } = render(<PaneButton wide />)
    expect(container).toBeEmptyDOMElement()
  })

  // reason: a desktop older than these buttons exposes neither call, and half
  // a bridge would render a button that does nothing.
  it.each([
    ['nothing it recognizes', { somethingElse: true }],
    ['only the older single toggle', { togglePane: () => {} }],
    ['only half the bridge', { toggleFiles: () => {} }],
  ])('renders nothing when the page offers %s', (_case, bridge) => {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = bridge
    const { container } = render(<PaneButton wide />)
    expect(container).toBeEmptyDOMElement()
  })

  it('toggles the tree from its own button', () => {
    const bridge = bridged()
    render(<PaneButton wide />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle the file tree' }))
    expect(bridge.toggleFiles).toHaveBeenCalledTimes(1)
    expect(bridge.toggleWeb).not.toHaveBeenCalled()
  })

  it('toggles the browser from its own button', () => {
    const bridge = bridged()
    render(<PaneButton wide />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle the browser' }))
    expect(bridge.toggleWeb).toHaveBeenCalledTimes(1)
    expect(bridge.toggleFiles).not.toHaveBeenCalled()
  })

  // reason: the rail is 56px wide, so a label would be clipped rather than
  // shortened.
  it('drops its labels in the narrow rail, keeping the accessible names', () => {
    bridged()
    render(<PaneButton wide={false} />)
    expect(screen.getByRole('button', { name: 'Toggle the file tree' })).not.toHaveTextContent('Files')
    expect(screen.getByRole('button', { name: 'Toggle the browser' })).not.toHaveTextContent('Browser')
  })

  it('shows the labels when the sidebar is wide', () => {
    bridged()
    render(<PaneButton wide />)
    expect(screen.getByRole('button', { name: 'Toggle the file tree' })).toHaveTextContent('Files')
    expect(screen.getByRole('button', { name: 'Toggle the browser' })).toHaveTextContent('Browser')
  })
})
