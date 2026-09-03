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

/** What a right-click on a git row offers. */
export type GitRowAction = 'stage' | 'unstage' | 'discard' | 'open-diff'

/**
 * One clickable entry in a native menu.
 *
 * Generic in its action so the two menus keep their own vocabularies: a
 * handler that switches on the result gets an exhaustive set of cases rather
 * than the union of every menu in the app, and a git action can never be
 * returned from the tree's menu by mistake.
 */
export interface MenuChoice<Action extends string> {
  action: Action
  label: string
  enabled?: boolean
}

/** One entry in the tree's menu, or a separator. */
export type TreeMenuItem = MenuChoice<TreeAction> | { separator: true }

/** One entry in a git row's menu, or a separator. */
export type GitMenuItem = MenuChoice<GitRowAction> | { separator: true }

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

/**
 * The menu for one row of the git panel.
 *
 * The same actions the row shows on hover, because hover is unreachable from
 * the keyboard and invisible on a trackpad until the pointer is already over
 * the row.
 *
 * Staging a staged row and unstaging an unstaged one are both nonsense, so
 * each row offers only the direction it can go. Discard is absent from a
 * staged row for the same reason: what a staged row would discard is the
 * working tree's copy, which is the *changed* row's business.
 * @param section - which list the row is in.
 * @returns the items to show, in order.
 */
export function gitRowMenu(section: 'staged' | 'changed' | 'untracked'): GitMenuItem[] {
  return [
    { action: 'open-diff', label: 'Open Diff' },
    { separator: true },
    ...(section === 'staged'
      ? ([{ action: 'unstage', label: 'Unstage' }] as GitMenuItem[])
      : ([
          { action: 'stage', label: 'Stage' },
          // The ellipsis is a promise: this one asks before it throws work
          // away, the way Delete in the tree does.
          { action: 'discard', label: 'Discard…' },
        ] as GitMenuItem[])),
  ]
}
