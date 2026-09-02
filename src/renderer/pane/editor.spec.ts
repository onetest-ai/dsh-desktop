import { describe, expect, it, vi } from 'vitest'
import { Editor, type Document, type EditorDeps, type Tab } from './editor'

const FILE = { root: '/p/demo', relative: 'readme.md' }
const OTHER = { root: '/p/demo', relative: 'other.md' }

/** A document whose buffer is whatever was opened, until a test changes it. */
function document(text: string): Document & { buffer: string; selected: string; shown: number; gone: boolean } {
  return {
    buffer: text,
    selected: '',
    shown: 0,
    gone: false,
    text() {
      return this.buffer
    },
    selection() {
      return this.selected
    },
    activate() {
      this.shown += 1
    },
    destroy() {
      this.gone = true
    },
  }
}

type Fake = EditorDeps & {
  said: string[]
  renders: number
  columnClosed: number
  documents: EditorDeps['documents'] & { made: ReturnType<typeof document>[] }
}

/** Deps whose reads succeed, overridable per test — never the documents. */
function deps(overrides: Omit<Partial<EditorDeps>, 'documents'> = {}): Fake {
  const said: string[] = []
  const made: ReturnType<typeof document>[] = []
  const fake: Fake = {
    said,
    renders: 0,
    columnClosed: 0,
    readFile: vi.fn(async () => ({ ok: true, text: 'on disk' }) as const),
    writeFile: vi.fn(async () => ({ ok: true }) as const),
    say: (message: string) => said.push(message),
    render: () => {
      fake.renders += 1
    },
    closeColumn: () => {
      fake.columnClosed += 1
    },
    documents: {
      made,
      open: (text: string) => {
        const made1 = document(text)
        made.push(made1)
        return made1
      },
      openDiff: (_original: string, proposed: string, _name: string, _inline?: boolean) => {
        const made1 = document(proposed)
        made.push(made1)
        return made1
      },
      openMedia: (url: string) => {
        const made1 = document(url)
        made.push(made1)
        return made1
      },
    },
    ...overrides,
  }
  return fake
}

/** An editor with the given files already open, the last one showing. */
async function withOpen(d: Fake, ...files: { root: string; relative: string }[]): Promise<Editor> {
  const editor = new Editor(d)
  for (const file of files) await editor.open(file)
  return editor
}

describe('Editor', () => {
  it('opens a file and shows it', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    expect(editor.current).toEqual(FILE)
    expect(editor.openTabs.length).toBe(1)
    expect(editor.dirty).toBe(false)
  })

  it('reports why a file could not be opened, and opens nothing', async () => {
    const d = deps({ readFile: vi.fn(async () => ({ ok: false, reason: 'That file is not text.' }) as const) })
    const editor = new Editor(d)
    await editor.open(FILE)
    expect(d.said).toContain('That file is not text.')
    expect(editor.openTabs.length).toBe(0)
  })

  it('keeps a tab per file, in the order they were opened', async () => {
    const editor = await withOpen(deps(), FILE, OTHER)
    expect(editor.openTabs.map((tab) => tab.file.relative)).toEqual(['readme.md', 'other.md'])
    expect(editor.current).toEqual(OTHER)
  })

  // reason: a second tab for a file already open is not a second file, and
  // re-reading it would throw away edits the user has not saved.
  it('brings an already-open file forward instead of opening it twice', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE, OTHER)
    d.documents.made[0].buffer = 'my edits'
    await editor.open(FILE)
    expect(editor.openTabs.length).toBe(2)
    expect(editor.current).toEqual(FILE)
    expect(editor.dirty).toBe(true)
  })

  it('shows a tab that is brought forward, and nothing else', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE, OTHER)
    editor.show(editor.openTabs[0])
    expect(editor.current).toEqual(FILE)
    expect(d.said).toContain('readme.md')
  })

  // reason: this is the whole difference between tabs and a viewer that
  // reloads — the document survives, so its undo history and scroll do too.
  it('never releases a document just because another tab is shown', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE, OTHER)
    editor.show(editor.openTabs[0])
    expect(d.documents.made.every((made) => !made.gone)).toBe(true)
  })

  it('closes a tab and shows its neighbour', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE, OTHER)
    editor.close(editor.openTabs[0])
    expect(editor.openTabs.map((tab) => tab.file.relative)).toEqual(['other.md'])
    expect(editor.current).toEqual(OTHER)
    expect(d.documents.made[0].gone).toBe(true)
  })

  it('shows the new last tab when the closed one was last', async () => {
    const editor = await withOpen(deps(), FILE, OTHER)
    editor.close(editor.openTabs[1])
    expect(editor.current).toEqual(FILE)
  })

  // reason: an editor with nothing in it has no reason to take width from the
  // conversation beside it.
  it('closes the column when the last tab goes', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    editor.close(editor.openTabs[0])
    expect(editor.openTabs.length).toBe(0)
    expect(editor.current).toBeUndefined()
    expect(d.columnClosed).toBe(1)
  })

  it('writes the showing tab, not whichever was opened first', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE, OTHER)
    d.documents.made[1].buffer = 'edited'
    await editor.save()
    expect(d.writeFile).toHaveBeenCalledWith('/p/demo', 'other.md', 'edited')
  })

  it('saves nothing when no file is open', async () => {
    const d = deps()
    await new Editor(d).save()
    expect(d.writeFile).not.toHaveBeenCalled()
  })

  it('reports a refused save without marking the tab clean', async () => {
    const d = deps({ writeFile: vi.fn(async () => ({ ok: false, reason: 'EACCES' }) as const) })
    const editor = await withOpen(d, FILE)
    d.documents.made[0].buffer = 'edited'
    await editor.save()
    expect(d.said).toContain('EACCES')
    expect(editor.dirty).toBe(true)
  })

  it('reports what the user has selected in the showing tab', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE, OTHER)
    d.documents.made[1].selected = 'a phrase'
    expect(editor.selection()).toBe('a phrase')
  })

  it('reports no selection when nothing is open', () => {
    expect(new Editor(deps()).selection()).toBe('')
  })
})

describe('Editor and changes made outside it', () => {
  // reason: that is the agent editing a file the user happens to have open.
  it('takes an outside change into a clean tab', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    ;(d.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'changed' })
    await editor.reload(FILE)
    expect(editor.openTabs[0].document.text()).toBe('changed')
    expect(editor.dirty).toBe(false)
  })

  // reason: a tab the user comes back to must not show text from before the
  // change, so a background tab reloads the same as the showing one.
  it('reloads a tab that is not showing, and leaves it where it was', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE, OTHER)
    ;(d.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'changed' })
    await editor.reload(FILE)
    expect(editor.openTabs.map((tab) => tab.file.relative)).toEqual(['readme.md', 'other.md'])
    expect(editor.openTabs[0].document.text()).toBe('changed')
    // Still showing what it was showing.
    expect(editor.current).toEqual(OTHER)
  })

  // reason: unsaved work is the one thing here that exists nowhere else.
  it('never overwrites a dirty tab, and says why', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    d.documents.made[0].buffer = 'my edits'
    await editor.reload(FILE)
    expect(d.said.some((message) => message.includes('changed on disk'))).toBe(true)
    expect(editor.openTabs[0].document.text()).toBe('my edits')
  })

  it('ignores a change to a file it does not have open', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    d.said.length = 0
    await editor.reload(OTHER)
    expect(d.said).toEqual([])
  })
})

// reason: a file may now hold two tabs, and the diff is added first — a
// lookup by path alone finds it, sees a mode that is not `edit`, and returns.
// The editable tab behind it would then never reload and never be written:
// the user reads text from before the agent's change, and their own edits
// stay on the floor. Both of these fail if the lookup is not mode-aware.
describe('Editor with a diff and the file itself open at once', () => {
  it('reloads the editable tab past a diff for the same file', async () => {
    const d = deps()
    const editor = new Editor(d)
    editor.showTexts(FILE, 'index', 'working', false)
    await editor.open(FILE)
    ;(d.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'changed' })
    await editor.reload(FILE)
    expect(editor.openTabs.map((tab) => tab.mode)).toEqual(['diff', 'edit'])
    expect(editor.openTabs[1].document.text()).toBe('changed')
  })

  it('saves the editable tab past a diff for the same file', async () => {
    const d = deps()
    const editor = new Editor(d)
    editor.showTexts(FILE, 'index', 'working', false)
    await editor.open(FILE)
    d.documents.made[1].buffer = 'my edits'
    await editor.saveIfDirty(FILE.root, FILE.relative)
    expect(d.writeFile).toHaveBeenCalledWith(FILE.root, FILE.relative, 'my edits')
  })
})

describe('Editor and proposed changes', () => {
  it('shows a file beside the text proposed for it', async () => {
    const d = deps()
    const editor = new Editor(d)
    await editor.showDiff(FILE, '# proposed')
    expect(editor.openTabs[0].mode).toBe('diff')
    expect(d.said.some((message) => message.includes('Proposed change'))).toBe(true)
  })

  // reason: saving from a diff would write the agent's proposal as though the
  // user had made it.
  it('refuses to save from a diff, and says why', async () => {
    const d = deps()
    const editor = new Editor(d)
    await editor.showDiff(FILE, '# proposed')
    await editor.save()
    expect(d.writeFile).not.toHaveBeenCalled()
    expect(d.said.some((message) => message.includes('proposed change'))).toBe(true)
  })

  // reason: two tabs for one path, one of them read-only, is a puzzle rather
  // than a convenience.
  it('replaces a clean tab for the same file rather than opening a second', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    await editor.showDiff(FILE, '# proposed')
    expect(editor.openTabs.length).toBe(1)
    expect(editor.openTabs[0].mode).toBe('diff')
  })

  // reason: an agent's proposal must never take away an edit the user has not
  // saved.
  it('refuses to replace a dirty tab, and says why', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    d.documents.made[0].buffer = 'my edits'
    await editor.showDiff(FILE, '# proposed')
    expect(editor.openTabs.length).toBe(1)
    expect(editor.openTabs[0].mode).toBe('edit')
    expect(d.said.some((message) => message.includes('unsaved edits'))).toBe(true)
  })

  // reason: a diff and the file it is about are two tabs, not two claims on
  // one — opening the file brings up an editable tab and leaves the diff
  // where it was, which is the whole point of reading a change and then
  // making one.
  it('opens an editable tab beside a diff rather than closing it', async () => {
    const d = deps()
    const editor = new Editor(d)
    await editor.showDiff(FILE, '# proposed')
    await editor.open(FILE)
    expect(editor.openTabs.map((tab) => tab.mode)).toEqual(['diff', 'edit'])
    // The editable one is what is showing, and what a save writes.
    await editor.save()
    expect(d.writeFile).toHaveBeenCalled()
  })

  it('ignores an outside change while a diff is showing', async () => {
    const d = deps()
    const editor = new Editor(d)
    await editor.showDiff(FILE, '# proposed')
    d.said.length = 0
    await editor.reload(FILE)
    expect(d.said).toEqual([])
  })

  it('reports why a diff could not be read', async () => {
    const d = deps({ readFile: vi.fn(async () => ({ ok: false, reason: 'That file is not text.' }) as const) })
    await new Editor(d).showDiff(FILE, '# proposed')
    expect(d.said).toContain('That file is not text.')
  })
})

/** Every tab's file path, for readability in failures. */
export function paths(tabs: readonly Tab[]): string[] {
  return tabs.map((tab) => tab.file.relative)
}

describe('Editor and files that are not text', () => {
  const IMAGE = { root: '/p/demo', relative: 'assets/shot.png' }

  it('shows an image without reading it', async () => {
    const d = deps()
    const editor = new Editor(d)
    editor.showMedia(IMAGE, 'app://project/x/assets/shot.png')
    expect(d.readFile).not.toHaveBeenCalled()
    expect(editor.openTabs[0].mode).toBe('media')
    expect(editor.current).toEqual(IMAGE)
  })

  // reason: nothing was read, so there is no buffer to be dirty and nothing
  // to write back.
  it('is never dirty and saves nothing', async () => {
    const d = deps()
    const editor = new Editor(d)
    editor.showMedia(IMAGE, 'app://project/x/assets/shot.png')
    expect(editor.dirty).toBe(false)
    await editor.save()
    expect(d.writeFile).not.toHaveBeenCalled()
  })

  it('ignores an outside change, since it shows the file itself', async () => {
    const d = deps()
    const editor = new Editor(d)
    editor.showMedia(IMAGE, 'app://project/x/assets/shot.png')
    d.said.length = 0
    await editor.reload(IMAGE)
    expect(d.said).toEqual([])
  })

  it('brings an open image forward rather than opening it twice', () => {
    const d = deps()
    const editor = new Editor(d)
    editor.showMedia(IMAGE, 'app://project/x/assets/shot.png')
    editor.showMedia(IMAGE, 'app://project/x/assets/shot.png')
    expect(editor.openTabs.length).toBe(1)
  })

  it('closes like any other tab', () => {
    const d = deps()
    const editor = new Editor(d)
    editor.showMedia(IMAGE, 'app://project/x/assets/shot.png')
    editor.close(editor.openTabs[0])
    expect(editor.openTabs.length).toBe(0)
    expect(d.columnClosed).toBe(1)
  })

  // reason: the tree is its own page and cannot see these buffers, so
  // anything acting on a file as it stands has to save through here first.
  describe('saveIfDirty', () => {
    it('writes a file that is open with unsaved edits, even when another tab is showing', async () => {
      const d = deps()
      const editor = await withOpen(d, FILE, OTHER)
      const tab = editor.openTabs.find((each) => each.file.relative === FILE.relative)
      // The fake document is the buffer; a test edit is a write to it.
      ;(tab?.document as unknown as { buffer: string }).buffer = 'edited'
      expect(editor.current).toEqual(OTHER)

      await editor.saveIfDirty(FILE.root, FILE.relative)
      expect(d.writeFile).toHaveBeenCalledWith(FILE.root, FILE.relative, 'edited')
    })

    it('writes nothing for a file that is open and clean', async () => {
      const d = deps()
      const editor = await withOpen(d, FILE)
      await editor.saveIfDirty(FILE.root, FILE.relative)
      expect(d.writeFile).not.toHaveBeenCalled()
    })

    it('writes nothing for a file that is not open at all', async () => {
      const d = deps()
      const editor = await withOpen(d, FILE)
      await editor.saveIfDirty('/p/demo', 'never-opened.html')
      expect(d.writeFile).not.toHaveBeenCalled()
    })
  })
})

// reason: `showDiff` reads disk as the original because it was written for
// an agent proposing a change. A git diff supplies both sides itself.
describe('showTexts', () => {
  it('opens a diff from two texts, reading nothing from disk', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    ;(d.readFile as ReturnType<typeof vi.fn>).mockClear()
    editor.showTexts({ root: '/p/demo', relative: 'x.ts' }, 'before', 'after', true)
    expect(d.readFile).not.toHaveBeenCalled()
    expect(editor.openTabs.some((tab) => tab.mode === 'diff')).toBe(true)
  })

  // reason: a file with unsaved edits is exactly when its diff is most
  // worth seeing. `showDiff` refuses in that case, to protect the user's
  // work from an agent's proposal; that rule does not apply here.
  it('leaves the editor tab open, and opens beside it even when dirty', async () => {
    const d = deps()
    const editor = await withOpen(d, FILE)
    const tab = editor.openTabs[0]
    ;(tab.document as unknown as { buffer: string }).buffer = 'edited'
    editor.showTexts(FILE, 'before', 'after', true)
    expect(editor.openTabs.length).toBe(2)
    expect(editor.openTabs.filter((each) => each.mode === 'diff').length).toBe(1)
    expect(editor.openTabs.some((each) => each.mode === 'edit')).toBe(true)
  })

  it('replaces its own diff tab rather than stacking them up', async () => {
    const editor = await withOpen(deps(), FILE)
    editor.showTexts(FILE, 'a', 'b', true)
    editor.showTexts(FILE, 'c', 'd', true)
    expect(editor.openTabs.filter((each) => each.mode === 'diff').length).toBe(1)
  })
})
