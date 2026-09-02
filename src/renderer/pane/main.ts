import { PANE_TABS, selectTab, type PaneTab, type TabView } from './tabs.ts'
import { Editor } from './editor.ts'
import { normalizeAddress } from './address.ts'
import { isMarkdown, openMarkdownLink, renderMarkdown } from './markdown.ts'
import { isMedia } from './media-kind.ts'
import { monacoDocuments, setEditorTheme } from './monaco-surface.ts'
import './bridge.ts'
import { followHarnessTheme } from './theme.ts'

// Main decides the theme and pushes it, before any document is mounted; the
// editor's own theme is process-wide, so this one call moves every open
// document at once.
followHarnessTheme(setEditorTheme)

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
    el('status-text').textContent = message
  },
  render: renderFileTabs,
  closeColumn: () => {
    window.pane.closeEditor()
  },
  documents: monacoDocuments(el('editor-host')),
})

/**
 * Draw one entry per open file, marking the one showing.
 *
 * Redrawn whole on every change rather than patched: the strip is a handful
 * of buttons, and a rebuild cannot disagree with the tabs it is drawn from.
 */
function renderFileTabs(): void {
  const strip = el('file-tabs')
  strip.textContent = ''
  const tabs = editor.openTabs
  strip.hidden = tabs.length === 0
  el('editor-empty').hidden = tabs.length > 0
  el('editor-host').hidden = tabs.length === 0

  for (const tab of tabs) {
    const showing = editor.current?.root === tab.file.root && editor.current.relative === tab.file.relative
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'file-tab'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(showing))
    button.title = tab.file.relative

    const name = document.createElement('span')
    name.className = 'file-tab-name'
    // The file's own name, not its path: the path is in the status line, and
    // a strip of paths is unreadable at tab width.
    name.textContent = `${tab.mode === 'diff' ? '± ' : ''}${tab.file.relative.split('/').pop() ?? tab.file.relative}`
    button.append(name)
    button.addEventListener('click', () => {
      editor.show(tab)
    })
    strip.append(button)

    if (editor.isDirty(tab)) {
      const dirty = document.createElement('span')
      dirty.className = 'file-tab-dirty'
      dirty.setAttribute('aria-label', 'Unsaved')
      dirty.textContent = '•'
      button.append(dirty)
      continue
    }
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'file-tab-close'
    close.setAttribute('aria-label', `Close ${tab.file.relative}`)
    close.textContent = '✕'
    close.addEventListener('click', (event) => {
      // Without this the tab's own click handler runs too, showing the tab
      // that is on its way out.
      event.stopPropagation()
      editor.close(tab)
    })
    button.append(close)
  }
  renderPreview()
}

/**
 * Which open files are being shown rendered rather than as source.
 *
 * Per file, not one flag for the pane: someone reading a report and editing a
 * spec wants each tab to stay as they left it.
 */
const rendered = new Set<string>()

/** The key a tab is remembered by, unique across projects. */
function keyOf(file: { root: string; relative: string }): string {
  return `${file.root}\u0000${file.relative}`
}

/**
 * Show the current tab as source or rendered, and set the toggle to match.
 *
 * Re-read from the document every time rather than cached: the buffer is
 * what the user has, edits included, and a preview of stale text would be a
 * preview of a file that does not exist.
 */
function renderPreview(): void {
  const file = editor.current
  const tab = editor.openTabs.find((each) => file !== undefined && each.file.relative === file.relative && each.file.root === file.root)
  const toggle = el('toggle-preview') as HTMLButtonElement
  const preview = el('preview')

  if (file === undefined || tab === undefined || !isMarkdown(file.relative)) {
    toggle.hidden = true
    preview.hidden = true
    preview.textContent = ''
    el('editor-host').hidden = editor.openTabs.length === 0
    return
  }
  toggle.hidden = false
  const showing = rendered.has(keyOf(file))
  toggle.textContent = showing ? 'Source' : 'Preview'
  toggle.setAttribute('aria-pressed', String(showing))
  preview.hidden = !showing
  el('editor-host').hidden = showing
  // Sanitized in `renderMarkdown`; this is the only place the result reaches
  // the DOM.
  preview.innerHTML = showing ? renderMarkdown(tab.document.text()) : ''
}

el('toggle-preview').addEventListener('click', () => {
  const file = editor.current
  if (file === undefined) return
  const key = keyOf(file)
  if (rendered.has(key)) rendered.delete(key)
  else rendered.add(key)
  renderPreview()
})

// Asked for by main when the tree's Open in Web names a file. Saving first
// is what makes the preview the file as it stands: the web view loads from
// disk, and unsaved edits are invisible to it.
window.pane.onSaveForWeb((root, relative) => {
  void editor.saveIfDirty(root, relative).then(() => {
    window.pane.loadInWeb(root, relative)
  })
})

// A preview is not a browser: a link opens where the user's links open.
el('preview').addEventListener('click', (event) => {
  const url = openMarkdownLink(event.target as Element | null)
  if (url === undefined) return
  event.preventDefault()
  window.pane.openExternal(url)
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

window.pane.onOpenFile((root, relative, url) => {
  selectTab('editor', view)
  // An image, a video, a PDF: shown from the file itself rather than read as
  // text, which is what `readTextFile` would refuse anyway.
  if (isMedia(relative)) editor.showMedia({ root, relative }, url)
  else void editor.open({ root, relative })
})

window.pane.onFileChanged((root, relative) => {
  void editor.reload({ root, relative })
})

window.pane.onShowDiff((root, relative, proposed) => {
  selectTab('editor', view)
  void editor.showDiff({ root, relative }, proposed)
})

// Sent by main when a row in the git panel is clicked. Both sides come from
// git, so nothing is read from disk and the file's own tab is left alone.
window.pane.onDiffTexts((root, relative, original, modified, inline) => {
  selectTab('editor', view)
  editor.showTexts({ root, relative }, original, modified, inline)
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
