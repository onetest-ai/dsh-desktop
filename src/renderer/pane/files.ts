import { Tree, type Project, type TreeEntry } from './tree.ts'
import { fileIcon } from './file-icon.ts'
import { badgedIcon, icon } from './icons.ts'
import './bridge.ts'
import { followHarnessTheme } from './theme.ts'

// Applies the harness's dark-mode attribute to this page; the tree draws in
// tokens, so nothing here needs the answer.
followHarnessTheme(() => {})

el('new-file').append(badgedIcon('document'))
el('new-folder').append(badgedIcon('folderClosed'))

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

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      void openMenu(path, entry.directory)
    })
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

/** What was copied or cut, waiting to be pasted. */
let held: { relative: string; move: boolean } | undefined

/**
 * Open the context menu for one row and act on what it says.
 *
 * The menu is native and lives in main; this only says what it was opened on
 * and carries out the answer.
 * @param relative - the row's path within the project.
 * @param directory - whether the row is a directory.
 * @returns resolution once the chosen action has finished.
 */
async function openMenu(relative: string, directory: boolean): Promise<void> {
  const project = tree.root
  if (project === undefined) return
  const action = await window.pane.treeMenu({ directory, pending: held !== undefined, name: relative })
  switch (action) {
    case 'open': {
      tree.openFile(relative)
      return
    }
    case 'new-file':
    case 'new-folder': {
      // Created inside the folder that was right-clicked, which is the whole
      // point of reaching this from the tree rather than from the header.
      startCreating(action === 'new-file' ? 'file' : 'folder', relative)
      return
    }
    case 'copy':
    case 'cut': {
      held = { relative, move: action === 'cut' }
      return
    }
    case 'paste': {
      if (held === undefined) return
      const outcome = await window.pane.pasteEntry(project.path, held.relative, relative, held.move)
      // A cut is spent once it lands; a copy can be pasted again.
      if (outcome.ok && held.move) held = undefined
      await afterChange(outcome, [parentOf(held?.relative ?? ''), relative])
      return
    }
    case 'rename': {
      startRenaming(relative)
      return
    }
    case 'delete': {
      const outcome = await window.pane.deleteEntry(project.path, relative, directory)
      await afterChange(outcome, [parentOf(relative)])
      return
    }
    case 'open-in-web': {
      window.pane.openInWeb(project.path, relative)
      return
    }
    case 'reveal': {
      window.pane.revealEntry(project.path, relative)
      return
    }
    case 'copy-path': {
      window.pane.copyPath(project.path, relative)
      return
    }
    case 'add-to-chat': {
      window.pane.addToChat(project.path, relative, directory)
      return
    }
    default:
      // Dismissed without choosing anything.
      return
  }
}

/**
 * The directory one path sits in, as a path within the project.
 * @param relative - the entry's path.
 * @returns its parent's path, '' for the root.
 */
function parentOf(relative: string): string {
  const cut = relative.lastIndexOf('/')
  return cut === -1 ? '' : relative.slice(0, cut)
}

/**
 * Redraw after an operation, or report why it did not happen.
 * @param outcome - what the operation reported.
 * @param directories - the directories whose listings may have changed.
 * @returns resolution once the tree is redrawn.
 */
async function afterChange(
  outcome: { ok: true; relative: string } | { ok: false; reason: string },
  directories: string[],
): Promise<void> {
  if (!outcome.ok) {
    // An empty reason is a cancelled confirmation, not a failure to report.
    if (outcome.reason !== '') report(outcome.reason)
    return
  }
  for (const directory of new Set(directories)) await tree.refresh(directory)
  drawTree('', el('file-tree'))
}

/**
 * Say why something did not happen, where the tree can be seen saying it.
 * @param message - what to show.
 */
function report(message: string): void {
  const error = el('new-entry-error')
  error.textContent = message
  error.hidden = false
}

/** The entry being renamed, while the name field is open for it. */
let renaming: string | undefined

/**
 * Open the name field to rename one entry.
 * @param relative - the entry's path within the project.
 */
function startRenaming(relative: string): void {
  renaming = relative
  creating = undefined
  const field = el('new-entry-name') as HTMLInputElement
  field.value = relative.split('/').pop() ?? relative
  field.placeholder = 'new name'
  el('new-entry').hidden = false
  el('new-entry-error').hidden = true
  field.focus()
  field.select()
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
 * @param into - the folder to create it in; the header's buttons pass none
 *   and get whatever the tree last opened.
 */
function startCreating(kind: 'file' | 'folder', into?: string): void {
  if (tree.root === undefined) return
  creating = kind
  renaming = undefined
  creatingIn = into ?? selectedParent()
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
  renaming = undefined
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
  if (project === undefined || name === '') {
    stopCreating()
    return
  }
  if (renaming !== undefined) {
    const outcome = await window.pane.renameEntry(project.path, renaming, name)
    if (!outcome.ok) {
      report(outcome.reason)
      return
    }
    const parent = parentOf(renaming)
    stopCreating()
    await afterChange(outcome, [parent])
    return
  }
  if (creating === undefined) {
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

// Files arrive in a project from the agent and from the user's own editor,
// not only from this tree; a listing this page never re-reads is one that
// stops matching the disk within a minute of anyone working.
window.pane.onProjectChanged((root, relative) => {
  if (tree.root?.path !== root) return
  void tree.refresh(relative).then(() => {
    drawTree('', el('file-tree'))
  })
})

window.pane.askProject()
