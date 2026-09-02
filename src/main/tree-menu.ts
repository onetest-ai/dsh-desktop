/** What a context-menu choice asks for. */
export type TreeAction =
  | 'open'
  | 'open-in-web'
  | 'new-file'
  | 'new-folder'
  | 'rename'
  | 'delete'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'reveal'
  | 'copy-path'
  | 'add-to-chat'

/** One entry in the menu, or a separator. */
export type TreeMenuItem = { action: TreeAction; label: string; enabled?: boolean } | { separator: true }

/** What the menu is being opened on. */
export interface TreeTarget {
  /** Whether the row is a directory. */
  directory: boolean
  /** Whether something has been copied or cut and is waiting to be pasted. */
  pending: boolean
  /**
   * Whether the web view can render this entry as a page.
   *
   * Decided by the caller from the file's name: the menu says what applies,
   * and an entry that would load as source or not at all is worse than no
   * entry at all.
   */
  web: boolean
}

/**
 * The menu for one row of the tree.
 *
 * A folder can be created in and pasted into; a file can be opened — and a
 * page the web view can render can be opened there too. Both can
 * be renamed, copied, cut, deleted, revealed, and handed to the chat — the
 * operations that are about the entry rather than about what it contains.
 *
 * Paste is listed even with nothing to paste, disabled: an item that
 * disappears is one the user has to hunt for the next time it applies.
 * @param target - what the menu was opened on.
 * @returns the items to show, in order.
 */
export function treeMenu(target: TreeTarget): TreeMenuItem[] {
  return [
    ...(target.directory
      ? ([
          { action: 'new-file', label: 'New File…' },
          { action: 'new-folder', label: 'New Folder…' },
        ] as TreeMenuItem[])
      : ([
          { action: 'open', label: 'Open' },
          ...(target.web ? ([{ action: 'open-in-web', label: 'Open in Web' }] as TreeMenuItem[]) : []),
        ] as TreeMenuItem[])),
    { separator: true },
    { action: 'copy', label: 'Copy' },
    { action: 'cut', label: 'Cut' },
    ...(target.directory ? ([{ action: 'paste', label: 'Paste', enabled: target.pending }] as TreeMenuItem[]) : []),
    { separator: true },
    { action: 'rename', label: 'Rename…' },
    { action: 'delete', label: 'Delete' },
    { separator: true },
    { action: 'add-to-chat', label: 'Add to Chat' },
    { action: 'copy-path', label: 'Copy Path' },
    { action: 'reveal', label: 'Reveal in Finder' },
  ]
}
