import { PANE_TABS, selectTab, type PaneTab, type TabView } from './tabs.ts'

/** What the preload exposes on this page. */
declare global {
  interface Window {
    pane: { showWebView(visible: boolean): void }
  }
}

/**
 * One element by id.
 * @param id - the element's id.
 * @returns the element, which the page always declares.
 */
function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`pane: the page declares no #${id}`)
  return node
}

/** The DOM half of a tab change; the rule itself lives in `tabs.ts`. */
const view: TabView = {
  select: (tab) => {
    for (const each of PANE_TABS) {
      const button = el(`tab-${each}`)
      button.setAttribute('aria-selected', String(each === tab))
      button.tabIndex = each === tab ? 0 : -1
    }
  },
  reveal: (tab) => {
    for (const each of PANE_TABS) el(`panel-${each}`).hidden = each !== tab
  },
  showWebView: (visible) => {
    window.pane.showWebView(visible)
  },
}

for (const tab of PANE_TABS) {
  el(`tab-${tab}`).addEventListener('click', () => {
    selectTab(tab, view)
  })
}

// Arrow keys move between tabs, matching the Settings window's tab strip and
// what a native segmented control does.
for (const tab of PANE_TABS) {
  el(`tab-${tab}`).addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = PANE_TABS[(PANE_TABS.indexOf(tab) + step + PANE_TABS.length) % PANE_TABS.length]
    selectTab(next, view)
    el(`tab-${next}`).focus()
  })
}

selectTab('files', view)

export type { PaneTab }
