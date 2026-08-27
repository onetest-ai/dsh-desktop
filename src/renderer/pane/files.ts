import { Tree, type Project, type TreeEntry } from './tree.ts'
import './bridge.ts'
import { followHarnessTheme } from './theme.ts'

// Applies the harness's dark-mode attribute to this page; the tree draws in
// tokens, so nothing here needs the answer.
followHarnessTheme(() => {})

/**
 * One element by id.
 * @param id - the element's id.
 * @returns the element, which the page always declares.
 */
function el(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`files: the page declares no #${id}`)
  return node
}

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
  // The editor is a column of its own now, and main is what puts a file in
  // it — this page only says which file.
  select: () => {},
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

