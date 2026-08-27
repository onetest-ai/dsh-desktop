import { Tree, type Project, type TreeEntry } from './tree.ts'
import { fileGlyph } from './file-icon.ts'
import { icon } from './icons.ts'
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

    const expanded = tree.open.has(path)

    const twisty = document.createElement('span')
    twisty.className = 'twisty'
    // Only a directory turns: a file's column stays empty so the names below
    // it still line up.
    if (entry.directory) twisty.append(icon(expanded ? 'chevronDown' : 'triangleRight', 10))
    row.append(twisty)

    const glyph = document.createElement('span')
    glyph.className = 'glyph'
    const named = fileGlyph(entry.name, entry.directory, expanded)
    // Empty rather than absent when there is no glyph: the span holds the
    // column so every name in the tree starts at the same x.
    if (named !== undefined) glyph.append(icon(named, 14))
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
    name.textContent = 'No project open'
    el('file-tree').textContent = ''
    el('files-empty').hidden = false
    return
  }
  if (tree.root?.path === project.path) return
  name.textContent = project.title
  glyph.append(icon('folderOpen', 14))
  await tree.show(project)
  drawTree('', el('file-tree'))
}

// Main decides which project this is — the harness owns that, and a picker
// here would be a second way to choose one.
window.pane.onProject((project) => {
  void showProject(project)
})

window.pane.askProject()
