import { PANE_TABS, selectTab, type PaneTab, type TabView } from './tabs.ts'
import { Editor } from './editor.ts'
import { mountMonaco } from './monaco-surface.ts'
import { Tree, type Project, type TreeEntry } from './tree.ts'

/** What the preload exposes on this page. */
declare global {
  interface Window {
    pane: {
      showWebView(visible: boolean): void
      projects(): Promise<Project[]>
      listDirectory(root: string, relative: string): Promise<TreeEntry[]>
      openFile(root: string, relative: string): void
      readFile(root: string, relative: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
      writeFile(root: string, relative: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>
      onOpenFile(listener: (root: string, relative: string) => void): void
      onFileChanged(listener: (root: string, relative: string) => void): void
    }
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

// --- the file tree ------------------------------------------------------

/**
 * Draw one directory's entries into a list.
 * @param relative - the directory's path within the root.
 * @param into - the list element to fill.
 */
function drawTree(relative: string, into: HTMLElement): void {
  into.textContent = ''
  for (const entry of tree.entries(relative) ?? []) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    const item = document.createElement('li')

    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'row'

    const twisty = document.createElement('span')
    twisty.className = 'twisty'
    twisty.setAttribute('aria-hidden', 'true')
    twisty.textContent = entry.directory ? (tree.open.has(path) ? '▾' : '▸') : ''
    row.append(twisty)

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = entry.name
    row.append(name)

    row.addEventListener('click', () => {
      if (!entry.directory) {
        tree.openFile(path)
        return
      }
      void tree.toggle(path).then(() => {
        drawTree(relative, into)
      })
    })
    item.append(row)

    if (entry.directory && tree.open.has(path)) {
      const children = document.createElement('ul')
      children.className = 'tree'
      drawTree(path, children)
      item.append(children)
    }
    into.append(item)
  }
  el('files-empty').hidden = tree.root !== undefined
}

/** Fill the project picker and show whichever project is chosen. */
async function loadProjects(): Promise<void> {
  const picker = el('project') as HTMLSelectElement
  const projects = await window.pane.projects()
  picker.textContent = ''
  for (const project of projects) {
    const option = document.createElement('option')
    option.value = project.path
    option.textContent = project.title
    picker.append(option)
  }
  picker.disabled = projects.length === 0
  if (projects.length === 0) return
  // Most recently used first, as main orders them: the closest thing the
  // harness records to "the project I am working in".
  await tree.show(projects[0])
  drawTree('', el('file-tree'))
}

const tree = new Tree({
  projects: () => window.pane.projects(),
  listDirectory: (root, relative) => window.pane.listDirectory(root, relative),
  openFile: (root, relative) => {
    window.pane.openFile(root, relative)
  },
  select: (tab) => {
    selectTab(tab, view)
  },
})

el('project').addEventListener('change', (event) => {
  const path = (event.target as HTMLSelectElement).value
  void window.pane.projects().then(async (projects) => {
    const chosen = projects.find((project) => project.path === path)
    if (chosen === undefined) return
    await tree.show(chosen)
    drawTree('', el('file-tree'))
  })
})

void loadProjects()

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
