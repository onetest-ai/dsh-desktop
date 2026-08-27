import { describe, expect, it, vi } from 'vitest'
import { Editor, type EditorDeps, type Surface } from './editor'

const FILE = { root: '/p/demo', relative: 'readme.md' }

/** A surface whose buffer is whatever was mounted, until a test changes it. */
function surface(): Surface & { buffer: string; selected: string } {
  return {
    buffer: '',
    selected: '',
    text() {
      return this.buffer
    },
    selection() {
      return this.selected
    },
    destroy: vi.fn(),
  }
}

/** Deps whose reads succeed, overridable per test. */
function deps(
  overrides: Partial<EditorDeps> = {},
): EditorDeps & { said: string[]; surface: Surface & { buffer: string; selected: string } } {
  const said: string[] = []
  const mounted = surface()
  return {
    said,
    surface: mounted,
    readFile: vi.fn(async () => ({ ok: true, text: 'on disk' }) as const),
    writeFile: vi.fn(async () => ({ ok: true }) as const),
    say: (message: string) => said.push(message),
    mount: (text: string) => {
      mounted.buffer = text
      return mounted
    },
    mountDiff: (_original: string, proposed: string) => {
      mounted.buffer = proposed
      return mounted
    },
    ...overrides,
  }
}

/** An editor over the given deps. */
function editor(d: EditorDeps): Editor {
  return new Editor(d)
}

describe('Editor', () => {
  it('opens a file and holds its text', async () => {
    const target = editor(deps())
    await target.open(FILE)
    expect(target.current).toEqual(FILE)
    expect(target.dirty).toBe(false)
  })

  it('reports why a file could not be opened, and opens nothing', async () => {
    const d = deps({ readFile: vi.fn(async () => ({ ok: false, reason: 'That file is not text.' }) as const) })
    const target = editor(d)
    await target.open(FILE)
    expect(d.said).toContain('That file is not text.')
    expect(target.current).toBeUndefined()
  })

  it('writes the buffer and reports the save', async () => {
    const d = deps()
    const target = editor(d)
    await target.open(FILE)
    await target.save()
    expect(d.writeFile).toHaveBeenCalledWith('/p/demo', 'readme.md', 'on disk')
    expect(d.said).toContain('Saved readme.md')
  })

  it('saves nothing when no file is open', async () => {
    const d = deps()
    await editor(d).save()
    expect(d.writeFile).not.toHaveBeenCalled()
  })

  it('reports a refused save without marking the buffer clean', async () => {
    const d = deps({ writeFile: vi.fn(async () => ({ ok: false, reason: 'EACCES' }) as const) })
    const target = editor(d)
    await target.open(FILE)
    await target.save()
    expect(d.said).toContain('EACCES')
  })

  // reason: that is the agent editing a file the user happens to be looking
  // at. Showing stale text would be a lie about what is on disk.
  it('takes an outside change into a clean buffer', async () => {
    const d = deps()
    const target = editor(d)
    await target.open(FILE)
    ;(d.readFile as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'changed' })
    await target.reload(FILE)
    expect(d.said).toContain('readme.md')
    expect(target.dirty).toBe(false)
  })

  // reason: unsaved work is the one thing here that exists nowhere else.
  it('never overwrites a dirty buffer, and says why', async () => {
    const d = deps()
    const target = editor(d)
    await target.open(FILE)
    d.surface.buffer = 'my edits'
    expect(target.dirty).toBe(true)
    await target.reload(FILE)
    expect(d.said.some((message) => message.includes('changed on disk'))).toBe(true)
  })

  it('writes what the buffer holds now, not what was opened', async () => {
    const d = deps()
    const target = editor(d)
    await target.open(FILE)
    d.surface.buffer = 'my edits'
    await target.save()
    expect(d.writeFile).toHaveBeenCalledWith('/p/demo', 'readme.md', 'my edits')
    expect(target.dirty).toBe(false)
  })

  it('ignores a change to a file it does not have open', async () => {
    const d = deps()
    const target = editor(d)
    await target.open(FILE)
    d.said.length = 0
    await target.reload({ root: '/p/demo', relative: 'other.md' })
    expect(d.said).toEqual([])
  })

  it('ignores a change when nothing is open', async () => {
    const d = deps()
    await editor(d).reload(FILE)
    expect(d.said).toEqual([])
  })

  it('reports what the user has selected', async () => {
    const d = deps()
    const target = editor(d)
    await target.open(FILE)
    d.surface.selected = 'a phrase'
    expect(target.selection()).toBe('a phrase')
  })

  it('reports no selection when nothing is open', () => {
    expect(editor(deps()).selection()).toBe('')
  })

  it('shows a file beside the text proposed for it', async () => {
    const d = deps()
    const target = editor(d)
    await target.showDiff(FILE, '# proposed')
    expect(d.surface.text()).toBe('# proposed')
    expect(d.said.some((message) => message.includes('Proposed change'))).toBe(true)
  })

  // reason: saving from a diff would write the agent's proposal as though the
  // user had made it.
  it('refuses to save from a diff, and says why', async () => {
    const d = deps()
    const target = editor(d)
    await target.showDiff(FILE, '# proposed')
    await target.save()
    expect(d.writeFile).not.toHaveBeenCalled()
    expect(d.said.some((message) => message.includes('proposed change'))).toBe(true)
  })

  // reason: a diff is not a view of the file as it is, so a change to that
  // file is not something to fold into it.
  it('ignores an outside change while a diff is showing', async () => {
    const d = deps()
    const target = editor(d)
    await target.showDiff(FILE, '# proposed')
    d.said.length = 0
    await target.reload(FILE)
    expect(d.said).toEqual([])
  })

  it('reports why a diff could not be read', async () => {
    const d = deps({ readFile: vi.fn(async () => ({ ok: false, reason: 'That file is not text.' }) as const) })
    await editor(d).showDiff(FILE, '# proposed')
    expect(d.said).toContain('That file is not text.')
  })

  it('goes back to editing when a file is opened after a diff', async () => {
    const d = deps()
    const target = editor(d)
    await target.showDiff(FILE, '# proposed')
    await target.open(FILE)
    await target.save()
    expect(d.writeFile).toHaveBeenCalled()
  })
})
