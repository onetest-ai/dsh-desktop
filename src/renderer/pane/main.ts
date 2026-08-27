import { PANE_TABS, selectTab, type PaneTab, type TabView } from './tabs.ts'
import { Editor, type Surface } from './editor.ts'
import { normalizeAddress } from './address.ts'
import { mountDiff, mountMonaco } from './monaco-surface.ts'
import './bridge.ts'
import { followSystemTheme } from './theme.ts'

/** Whether the window is in dark mode, applied to this page as it loads. */
const dark = followSystemTheme()

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

selectTab('editor', view)

export type { PaneTab }

// --- the editor ---------------------------------------------------------

const editor = new Editor({
  readFile: (root, relative) => window.pane.readFile(root, relative),
  writeFile: (root, relative, text) => window.pane.writeFile(root, relative, text),
  say: (message) => {
    el('editor-status').textContent = message
  },
  mount: (text, name) => mountInto((host, dark) => mountMonaco(host, text, name, dark)),
  mountDiff: (original, proposed, name) =>
    mountInto((host, dark) => mountDiff(host, original, proposed, name, dark)),
})

/**
 * Reveal the editor host and mount something in it.
 * @param mount - builds the surface once the host is on screen.
 * @returns the mounted surface.
 */
function mountInto(mount: (host: HTMLElement, dark: boolean) => Surface): Surface {
  el('editor-empty').hidden = true
  el('editor-host').hidden = false
  return mount(el('editor-host'), matchMedia('(prefers-color-scheme: dark)').matches)
}

el('close-editor').addEventListener('click', () => {
  window.pane.closeEditor()
})

// Cmd/Ctrl+S saves, wherever the focus is in the pane: Monaco takes the
// keystroke inside its own editor, and this catches it everywhere else.
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key !== 's') return
  event.preventDefault()
  void editor.save()
})

// Opening a file is one path whether the click came from this pane's tree or
// from a tool the agent called: both arrive here.
window.pane.onOpenFile((root, relative) => {
  selectTab('editor', view)
  void editor.open({ root, relative })
})

window.pane.onFileChanged((root, relative) => {
  void editor.reload({ root, relative })
})

window.pane.onShowDiff((root, relative, proposed) => {
  selectTab('editor', view)
  void editor.showDiff({ root, relative }, proposed)
})

// Read by main when a tool asks what the user has selected. A function on the
// page rather than a channel, because main is the side that asks.
;(window as unknown as { __paneSelection: () => string }).__paneSelection = () => editor.selection()

window.pane.onShowWeb(() => {
  selectTab('web', view)
})

// --- the browser's chrome -----------------------------------------------

el('web-url').addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key !== 'Enter') return
  const url = normalizeAddress((el('web-url') as HTMLInputElement).value)
  if (url === undefined) return
  window.pane.navigate(url)
})

el('web-back').addEventListener('click', () => {
  window.pane.webBack()
})
el('web-forward').addEventListener('click', () => {
  window.pane.webForward()
})
el('web-reload').addEventListener('click', () => {
  window.pane.webReload()
})

window.pane.onWebState((state) => {
  const field = el('web-url') as HTMLInputElement
  // Not while it is being typed into: replacing the text under the cursor
  // mid-edit is how an address bar loses what someone was writing.
  if (document.activeElement !== field) field.value = state.url
  ;(el('web-back') as HTMLButtonElement).disabled = !state.canGoBack
  ;(el('web-forward') as HTMLButtonElement).disabled = !state.canGoForward
})
