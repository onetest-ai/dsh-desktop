import type { PaneTab } from './tabs.ts'

/** One entry in a directory listing, as main reports it. */
export interface TreeEntry {
  name: string
  directory: boolean
}

/** A project the harness has opened. */
export interface Project {
  path: string
  title: string
}

/** What the tree needs from main and from the rest of the pane. */
export interface TreeDeps {
  projects(): Promise<Project[]>
  listDirectory(root: string, relative: string): Promise<TreeEntry[]>
  /** Open one of the tree's files in another tab. */
  openFile(root: string, relative: string): void
  /** Move the pane to a tab. */
  select(tab: PaneTab): void
}

/**
 * The file tree's state: which project, and which directories are open.
 *
 * Directories are held open by path rather than by node, so a refresh redraws
 * the same expansion instead of collapsing everything the user opened.
 */
export class Tree {
  private project: Project | undefined
  private readonly expanded = new Set<string>()
  private readonly listings = new Map<string, TreeEntry[]>()

  constructor(private readonly deps: TreeDeps) {}

  /** The project currently shown, or undefined before one is chosen. */
  get root(): Project | undefined {
    return this.project
  }

  /** Every directory currently open, by path relative to the root. */
  get open(): ReadonlySet<string> {
    return this.expanded
  }

  /**
   * Load a project's top level.
   * @param project - the project to show.
   * @returns resolution once its root listing is in hand.
   */
  async show(project: Project): Promise<void> {
    this.project = project
    this.expanded.clear()
    this.listings.clear()
    await this.load('')
  }

  /**
   * The entries of one directory, or undefined when it has not been loaded.
   * @param relative - the directory's path within the root.
   * @returns its entries, if loaded.
   */
  entries(relative: string): TreeEntry[] | undefined {
    return this.listings.get(relative)
  }

  /**
   * Open or close a directory, loading it the first time it opens.
   * @param relative - the directory's path within the root.
   * @returns resolution once any load has finished.
   */
  async toggle(relative: string): Promise<void> {
    if (this.expanded.has(relative)) {
      this.expanded.delete(relative)
      return
    }
    this.expanded.add(relative)
    // Loaded once and kept: a directory the user closes and reopens is the
    // same directory, and a fresh read per open would make the tree flicker.
    if (!this.listings.has(relative)) await this.load(relative)
  }

  /**
   * Open a file in the Editor tab.
   * @param relative - the file's path within the root.
   */
  openFile(relative: string): void {
    if (this.project === undefined) return
    this.deps.openFile(this.project.path, relative)
    this.deps.select('editor')
  }

  /**
   * Read one directory into the listing cache.
   * @param relative - the directory's path within the root.
   */
  private async load(relative: string): Promise<void> {
    if (this.project === undefined) return
    this.listings.set(relative, await this.deps.listDirectory(this.project.path, relative))
  }
}
