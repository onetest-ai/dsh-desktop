import { describe, expect, it } from 'vitest'
import { treeMenu, type TreeMenuItem } from './tree-menu'

/** The actions a menu offers, in order, separators dropped. */
const actions = (items: TreeMenuItem[]): string[] =>
  items.filter((item): item is Exclude<TreeMenuItem, { separator: true }> => !('separator' in item)).map((item) => item.action)

describe('treeMenu', () => {
  it('offers a folder the things you do to a folder', () => {
    expect(actions(treeMenu({ directory: true, pending: false, web: false }))).toEqual([
      'new-file',
      'new-folder',
      'copy',
      'cut',
      'paste',
      'rename',
      'delete',
      'add-to-chat',
      'copy-path',
      'reveal',
    ])
  })

  // reason: creating inside a file makes no sense, and pasting into one has
  // nowhere to put what it holds.
  it('offers a file Open instead of creating and pasting', () => {
    const items = actions(treeMenu({ directory: false, pending: true, web: false }))
    expect(items).toContain('open')
    expect(items).not.toContain('new-file')
    expect(items).not.toContain('new-folder')
    expect(items).not.toContain('paste')
  })

  // reason: an item that disappears is one the user has to hunt for the next
  // time it applies.
  it('shows Paste disabled rather than hiding it when nothing is held', () => {
    const paste = treeMenu({ directory: true, pending: false, web: false }).find(
      (item) => 'action' in item && item.action === 'paste',
    )
    expect(paste).toEqual({ action: 'paste', label: 'Paste', enabled: false })
  })

  it('enables Paste once something is held', () => {
    const paste = treeMenu({ directory: true, pending: true }).find(
      (item) => 'action' in item && item.action === 'paste',
    )
    expect(paste).toMatchObject({ enabled: true })
  })

  it('separates the groups rather than running them together', () => {
    const items = treeMenu({ directory: true, pending: false })
    expect(items.filter((item) => 'separator' in item).length).toBe(3)
  })

  it('offers both kinds the same entry-level operations', () => {
    for (const directory of [true, false]) {
      const items = actions(treeMenu({ directory, pending: false }))
      for (const action of ['copy', 'cut', 'rename', 'delete', 'add-to-chat', 'copy-path', 'reveal']) {
        expect(items).toContain(action)
      }
    }
  })

  // reason: the web view renders a page as a browser would; a file it cannot
  // show would only load as text or not at all, and an entry that does
  // nothing is worse than no entry.
  it('offers Open in Web for a file the web view can show', () => {
    const items = treeMenu({ directory: false, pending: false, web: true })
    expect(actions(items)).toContain('open-in-web')
    expect(items).toContainEqual({ action: 'open-in-web', label: 'Open in Web' })
  })

  it('leaves Open in Web out for a file it cannot', () => {
    expect(actions(treeMenu({ directory: false, pending: false, web: false }))).not.toContain('open-in-web')
  })

  it('leaves Open in Web out for a folder, whatever it holds', () => {
    expect(actions(treeMenu({ directory: true, pending: false, web: true }))).not.toContain('open-in-web')
  })

  // reason: it belongs with Open, which is the other thing that shows the
  // file rather than acting on it.
  it('puts Open in Web next to Open', () => {
    const items = actions(treeMenu({ directory: false, pending: false, web: true }))
    expect(items.slice(0, 2)).toEqual(['open', 'open-in-web'])
  })
})
