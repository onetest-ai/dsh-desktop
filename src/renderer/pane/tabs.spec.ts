import { describe, expect, it, vi } from 'vitest'
import { PANE_TABS, selectTab, type PaneTab, type TabView } from './tabs'

/** A view that records what it was asked to do. */
function view(): TabView & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    select: vi.fn((tab: PaneTab) => calls.push(`select:${tab}`)),
    reveal: vi.fn((tab: PaneTab) => calls.push(`reveal:${tab}`)),
    showWebView: vi.fn((visible: boolean) => calls.push(`web:${String(visible)}`)),
  }
}

describe('selectTab', () => {
  it('marks the tab current and reveals its panel', () => {
    const target = view()
    selectTab('editor', target)
    expect(target.calls).toEqual(['select:editor', 'reveal:editor', 'web:false'])
  })

  // reason: the web view is a WebContentsView stacked over the pane, not an
  // element in the document. Leaving it up would cover whichever panel
  // replaced it, and the pane would look frozen on the last page.
  it('raises the web view only for the Web tab, and drops it for every other', () => {
    for (const tab of PANE_TABS) {
      const target = view()
      selectTab(tab, target)
      expect(target.showWebView).toHaveBeenCalledWith(tab === 'web')
    }
  })
})
