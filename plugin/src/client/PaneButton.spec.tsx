import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PaneButton } from './PaneButton.tsx'

afterEach(() => {
  cleanup()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

/** Put a desktop bridge on the page, as that app's preload does. */
function bridged(): { togglePane: ReturnType<typeof vi.fn> } {
  const bridge = { togglePane: vi.fn() }
  ;(globalThis as { dshDesktop?: unknown }).dshDesktop = bridge
  return bridge
}

describe('PaneButton', () => {
  // reason: the browser half is bundled once and served to whatever page
  // loads it. In a plain browser there is no tree, so a button offering to
  // toggle one would do nothing when clicked.
  it('renders nothing outside the desktop app', () => {
    const { container } = render(<PaneButton wide />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the bridge is there but cannot toggle', () => {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = { somethingElse: true }
    const { container } = render(<PaneButton wide />)
    expect(container).toBeEmptyDOMElement()
  })

  it('toggles the tree when clicked', () => {
    const bridge = bridged()
    render(<PaneButton wide />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle the file tree' }))
    expect(bridge.togglePane).toHaveBeenCalledTimes(1)
  })

  // reason: the rail is 56px wide, so a label would be clipped rather than
  // shortened.
  it('drops its label in the narrow rail, keeping the accessible name', () => {
    bridged()
    render(<PaneButton wide={false} />)
    expect(screen.getByRole('button', { name: 'Toggle the file tree' })).not.toHaveTextContent('Files')
  })

  it('shows the label when the sidebar is wide', () => {
    bridged()
    render(<PaneButton wide />)
    expect(screen.getByRole('button', { name: 'Toggle the file tree' })).toHaveTextContent('Files')
  })
})
