import { Tree, type Project, type TreeEntry } from './tree.ts'
import { fileIcon } from './file-icon.ts'
import { icon } from './icons.ts'
import './bridge.ts'
import { followHarnessTheme } from './theme.ts'

// Applies the harness's dark-mode attribute to this page; the tree draws in
// tokens, so nothing here needs the answer.
followHarnessTheme(() => {})

el('new-file').append(icon('newFile', 14))
el('new-folder').append(icon('newFolder', 14))

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

    const expanded = tree.open.has(path)

    const twisty = document.createElement('span')
    twisty.className = 'twisty'
    // Only a directory turns: a file's column stays empty so the names below
    // it still line up.
    if (entry.directory) twisty.append(icon(expanded ? 'chevronDown' : 'triangleRight', 10))
    row.append(twisty)

    const glyph = document.createElement('span')
    glyph.className = 'glyph'
    glyph.append(fileIcon(entry.name, entry.directory, expanded))
    row.append(glyph)

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

/** The tree's state; main decides which project it holds. */
const tree = new Tree({
  listDirectory: (root, relative) => window.pane.listDirectory(root, relative),
  openFile: (root, relative) => {
    window.pane.openFile(root, relative)
  },
  // The editor is a column of its own, and main is what puts a file in it —
  // this page only says which file.
  select: () => {},
})

/**
 * Show one project's tree.
 * @param project - the project to show, or undefined when there is none.
 * @returns resolution once its root listing is drawn.
 */
async function showProject(project: Project | undefined): Promise<void> {
  const name = el('project-name')
  const glyph = el('project-glyph')
  glyph.textContent = ''
  if (project === undefined) {
    for (const id of ['new-file', 'new-folder']) (el(id) as HTMLButtonElement).disabled = true
    name.textContent = 'No project open'
    el('file-tree').textContent = ''
    el('files-empty').hidden = false
    return
  }
  if (tree.root?.path === project.path) return
  name.textContent = project.title
  glyph.append(icon('folderOpen', 14))
  for (const id of ['new-file', 'new-folder']) (el(id) as HTMLButtonElement).disabled = false
  await tree.show(project)
  drawTree('', el('file-tree'))
}

/** What the name field, when open, is going to create. */
let creating: 'file' | 'folder' | undefined
/** The path within the project the new entry goes in; '' is the root. */
let creatingIn = ''

/**
 * Open the name field for a new file or folder.
 *
 * Named before it is created, in the tree, the way an editor does it — rather
 * than creating `untitled` and making the user rename it.
 * @param kind - what to create.
 */
function startCreating(kind: 'file' | 'folder'): void {
  if (tree.root === undefined) return
  creating = kind
  creatingIn = selectedParent()
  const field = el('new-entry-name') as HTMLInputElement
  field.value = ''
  field.placeholder = kind === 'file' ? 'file name' : 'folder name'
  el('new-entry').hidden = false
  el('new-entry-error').hidden = true
  field.focus()
}

/** Put the name field away, whether or not anything was created. */
function stopCreating(): void {
  creating = undefined
  el('new-entry').hidden = true
  el('new-entry-error').hidden = true
}

/**
 * Where a new entry goes, given what the tree last opened.
 *
 * Beside the last file opened, or inside the last directory expanded — the
 * closest this tree has to a selection.
 * @returns the parent's path within the project, '' for the root.
 */
function selectedParent(): string {
  const open = [...tree.open]
  return open.length === 0 ? '' : open[open.length - 1]
}

/**
 * Create what the name field describes, and show it.
 * @returns resolution once the tree has been redrawn.
 */
async function finishCreating(): Promise<void> {
  const project = tree.root
  const name = (el('new-entry-name') as HTMLInputElement).value.trim()
  if (project === undefined || creating === undefined || name === '') {
    stopCreating()
    return
  }
  const relative = creatingIn === '' ? name : `${creatingIn}/${name}`
  const outcome = creating === 'file'
    ? await window.pane.createFile(project.path, relative)
    : await window.pane.createFolder(project.path, relative)
  if (!outcome.ok) {
    const error = el('new-entry-error')
    error.textContent = outcome.reason
    error.hidden = false
    return
  }
  const wasFile = creating === 'file'
  stopCreating()
  await tree.refresh(creatingIn)
  drawTree('', el('file-tree'))
  // A new file opens, the way it does when you make one in an editor; a new
  // folder just appears, since there is nothing in it to show.
  if (wasFile) tree.openFile(relative)
}

el('new-file').addEventListener('click', () => {
  startCreating('file')
})
el('new-folder').addEventListener('click', () => {
  startCreating('folder')
})
el('new-entry').addEventListener('submit', (event) => {
  event.preventDefault()
  void finishCreating()
})
el('new-entry-name').addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Escape') stopCreating()
})
el('new-entry-name').addEventListener('blur', () => {
  // Clicking away is how someone changes their mind; a field left behind over
  // the tree is worse than losing a name they had not committed to.
  if (el('new-entry-error').hidden) stopCreating()
})

// Main decides which project this is — the harness owns that, and a picker
// here would be a second way to choose one.
window.pane.onProject((project) => {
  void showProject(project)
})

window.pane.askProject()
