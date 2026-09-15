import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic } from './atomic-write'

describe('writeFileAtomic', () => {
  it('writes a file, creating missing directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'nested', 'deep', 'payments.json')
    writeFileAtomic(target, '{"title":"Payments"}')
    expect(readFileSync(target, 'utf8')).toBe('{"title":"Payments"}')
  })

  it('writes bytes as well as text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-'))
    const target = join(dir, 'icon.png')
    writeFileAtomic(target, new Uint8Array([137, 80, 78, 71]))
    expect([...readFileSync(target)]).toEqual([137, 80, 78, 71])
  })

  it('leaves no temp file behind on success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-'))
    writeFileAtomic(join(dir, 'a.json'), '{}')
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  it('leaves no temp file behind when the rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-'))
    // A directory where the file should go: the rename cannot replace it.
    const target = join(dir, 'blocked')
    writeFileSync(join(dir, 'placeholder'), '')
    const asDirectory = join(target, 'inner')
    writeFileAtomic(asDirectory, '{}')
    expect(() => writeFileAtomic(target, '{}')).toThrow()
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([])
  })
})
