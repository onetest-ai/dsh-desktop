import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-write'

/** A fresh directory to write into. */
function directory(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-atomic-'))
}

describe('writeFileAtomic', () => {
  it('writes the contents', () => {
    const file = join(directory(), 'config.json')
    writeFileAtomic(file, '{"a":1}\n')
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n')
  })

  it('replaces what was there', () => {
    const file = join(directory(), 'config.json')
    writeFileSync(file, 'old')
    writeFileAtomic(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
  })

  it('creates the directory when it does not exist', () => {
    const file = join(directory(), 'deep', 'config.json')
    writeFileAtomic(file, 'x')
    expect(readFileSync(file, 'utf8')).toBe('x')
  })

  // reason: a reader that opens the file mid-write must never see it empty or
  // half-filled — which is what a plain write exposes, and what reads as a
  // broken configuration.
  it('leaves no temporary file behind', () => {
    const into = directory()
    writeFileAtomic(join(into, 'config.json'), 'x')
    expect(readdirSync(into)).toEqual(['config.json'])
  })

  it('keeps a file owner-only when asked', () => {
    const file = join(directory(), 'secrets.json')
    writeFileAtomic(file, 'x', 0o600)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  // reason: an existing temp file keeps its own mode, so a second write with
  // a mode has to set it again rather than trusting the create flag.
  it('sets the mode again over a temp file left by an earlier write', () => {
    const into = directory()
    const file = join(into, 'secrets.json')
    writeFileAtomic(file, 'first', 0o600)
    const temporary = join(into, `.secrets.json.${String(process.pid)}.tmp`)
    writeFileSync(temporary, 'stale')
    chmodSync(temporary, 0o644)
    writeFileAtomic(file, 'second', 0o600)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe('second')
  })

  // reason: a failed write must not leave a half-file where the real one goes,
  // and must not swallow the failure — the caller decides what to do about it.
  it('leaves the target untouched when the write fails, and reports it', () => {
    const into = directory()
    const file = join(into, 'config.json')
    writeFileSync(file, 'original')
    // A directory standing where the temp file goes: the write fails before
    // anything can be renamed over the target.
    mkdirSync(join(into, `.config.json.${String(process.pid)}.tmp`))
    expect(() => writeFileAtomic(file, 'replacement')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('original')
  })
})
