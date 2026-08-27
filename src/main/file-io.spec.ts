import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_EDITABLE_BYTES, readTextFile, writeTextFile } from './file-io'

/** A project directory. */
function project(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-fileio-'))
}

/** A project with one file in it. */
function withFile(name: string, contents: string | Buffer): { root: string; name: string } {
  const root = project()
  writeFileSync(join(root, name), contents)
  return { root, name }
}

describe('readTextFile', () => {
  it('reads a file inside the project', () => {
    const { root, name } = withFile('readme.md', '# hello')
    expect(readTextFile(root, name)).toEqual({ ok: true, text: '# hello' })
  })

  // reason: this path arrives from the renderer and from the model. It is the
  // same check the tree makes, for the same reason.
  it.each([
    ['a parent traversal', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
  ])('refuses %s', (_case, relative) => {
    expect(readTextFile(project(), relative)).toEqual({ ok: false, reason: 'That file is not inside the project.' })
  })

  it('refuses a symlink pointing out of the project', () => {
    const outside = withFile('secret.txt', 'shh')
    const root = project()
    symlinkSync(join(outside.root, 'secret.txt'), join(root, 'link.txt'))
    expect(readTextFile(root, 'link.txt').ok).toBe(false)
  })

  it('refuses a directory', () => {
    const root = project()
    mkdirSync(join(root, 'src'))
    expect(readTextFile(root, 'src')).toEqual({ ok: false, reason: 'That is a directory.' })
  })

  // reason: CodeMirror holds the whole document and re-highlights it. Past a
  // few megabytes that stops being an editor and starts being a hang.
  it('refuses a file too large to edit', () => {
    const { root, name } = withFile('huge.log', 'x'.repeat(MAX_EDITABLE_BYTES + 1))
    const outcome = readTextFile(root, name)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain('too large')
  })

  it('opens a file exactly at the limit', () => {
    const { root, name } = withFile('big.log', 'x'.repeat(MAX_EDITABLE_BYTES))
    expect(readTextFile(root, name).ok).toBe(true)
  })

  // reason: rendering an image as mojibake invites the user to save it back
  // over the original.
  it('refuses a binary file', () => {
    const { root, name } = withFile('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    expect(readTextFile(root, name)).toEqual({ ok: false, reason: 'That file is not text.' })
  })

  it('reads a text file whose only NUL is past the sniffed pages', () => {
    const { root, name } = withFile('late.txt', `${'a'.repeat(9_000)}\0`)
    expect(readTextFile(root, name).ok).toBe(true)
  })
})

describe('writeTextFile', () => {
  it('writes over a file inside the project', () => {
    const { root, name } = withFile('readme.md', 'old')
    expect(writeTextFile(root, name, 'new')).toEqual({ ok: true })
    expect(readFileSync(join(root, name), 'utf8')).toBe('new')
  })

  it.each([
    ['a parent traversal', '../escape.txt'],
    ['an absolute path', '/tmp/escape.txt'],
  ])('refuses %s', (_case, relative) => {
    expect(writeTextFile(project(), relative, 'x')).toEqual({
      ok: false,
      reason: 'That file is not inside the project.',
    })
  })

  // reason: `resolveInRoot` resolves through the filesystem, so a path with no
  // file behind it cannot be checked against the root at all. Creating files
  // is the agent's job, not this pane's.
  it('refuses a file that does not exist yet', () => {
    expect(writeTextFile(project(), 'new.txt', 'x').ok).toBe(false)
  })

  it('refuses a directory', () => {
    const root = project()
    mkdirSync(join(root, 'src'))
    expect(writeTextFile(root, 'src', 'x')).toEqual({ ok: false, reason: 'That is a directory.' })
  })
})
