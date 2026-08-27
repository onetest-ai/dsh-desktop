import type { CSSProperties } from 'react'
import { desktop } from './desktop.ts'

/** Props: the only thing the sidebar shares with a footer action. */
export interface PaneButtonProps {
  /** Whether the sidebar renders wide content; false is the 56px rail. */
  readonly wide: boolean
}

/**
 * The sidebar's toggles for the desktop app's own panels.
 *
 * Renders nothing outside that app: the panels belong to the Electron shell,
 * and in a plain browser there are none to toggle. The bridge's presence is
 * the test, so no version or user-agent sniffing is involved.
 * @param props - the sidebar's width state.
 * @returns the buttons, or null when there is no desktop app around them.
 */
export function PaneButton({ wide }: PaneButtonProps) {
  const bridge = desktop()
  if (bridge === undefined) return null
  return (
    <>
      <button
        type="button"
        style={wide ? WIDE : RAIL}
        title="Show or hide the file tree"
        aria-label="Toggle the file tree"
        onClick={() => { bridge.toggleFiles() }}
      >
        <span aria-hidden="true" style={GLYPH}>🗂</span>
        {wide ? <span>Files</span> : null}
      </button>
      <button
        type="button"
        style={wide ? WIDE : RAIL}
        title="Show or hide the browser"
        aria-label="Toggle the browser"
        onClick={() => { bridge.toggleWeb() }}
      >
        <span aria-hidden="true" style={GLYPH}>🌐</span>
        {wide ? <span>Browser</span> : null}
      </button>
    </>
  )
}

/** Shared between both widths; the sidebar owns the colours around it. */
const BASE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
}

const WIDE: CSSProperties = { ...BASE, gap: 10, width: '100%', padding: '7px 10px' }

/** The rail is 56px wide, so the label is dropped and the glyph centred. */
const RAIL: CSSProperties = { ...BASE, justifyContent: 'center', width: '100%', padding: '7px 0' }

const GLYPH: CSSProperties = { fontSize: 13, lineHeight: 1, opacity: 0.85 }
