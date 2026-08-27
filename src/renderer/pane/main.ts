import { PANE_TABS, selectTab, type PaneTab, type TabView } from './tabs.ts'
import { Editor } from './editor.ts'
import { mountMonaco } from './monaco-surface.ts'
import './bridge.ts'

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
  mount: (text, name) => {
    el('editor-empty').hidden = true
    el('editor-host').hidden = false
    return mountMonaco(el('editor-host'), text, name, matchMedia('(prefers-color-scheme: dark)').matches)
  },
})

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
