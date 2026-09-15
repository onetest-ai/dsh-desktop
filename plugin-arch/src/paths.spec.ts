import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { archRoot, resolveInArch, resolveInWorkspace } from './paths.ts'

let project: string
let outside: string

beforeAll(() => {
  // realpathSync is REQUIRED, not tidiness: on macOS `tmpdir()` is /var, a
  // symlink to /private/var. The boundary returns realpathed answers, so a
  // test comparing against a raw join() would fail on macOS and pass on Linux.
  project = realpathSync(mkdtempSync(join(tmpdir(), 'arch-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')))
  mkdirSync(archRoot(project), { recursive: true })
  writeFileSync(join(outside, 'secret.json'), '{}')
  // A symlink INSIDE the fence pointing OUTSIDE it: the attack a lexical check
  // cannot see, because the string never contains "..". One per fence, each at
  // its own base, so the SAME relative path exercises both.
  symlinkSync(outside, join(archRoot(project), 'escape'))
  symlinkSync(outside, join(project, 'escape'))
})

/**
 * One table, run against both fences. A refusal that only one of them
 * implements is the bug this shape exists to catch.
 */
const ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['a parent traversal', '../../etc/passwd'],
  ['a bare parent traversal', '..'],
  ['an absolute path', '/etc/passwd'],
  ['an empty path', ''],
  ['a traversal buried mid-path', 'a/../../../etc/passwd'],
  ['a symlink escaping the fence', 'escape/secret.json'],
  ['a path under a symlinked parent', 'escape/nested/deep.json'],
]

describe('resolveInArch', () => {
  it.each(ESCAPES)('refuses %s', (_case, attempt) => {
    expect(resolveInArch(project, attempt)).toBeUndefined()
  })

  it('accepts a plain diagram file', () => {
    expect(resolveInArch(project, 'payments.json')).toBe(join(archRoot(project), 'payments.json'))
  })

  it('accepts a nested icon path', () => {
    expect(resolveInArch(project, 'icons/aws/ec2.svg')).toBe(join(archRoot(project), 'icons', 'aws', 'ec2.svg'))
  })

  it('refuses the arch root itself', () => {
    expect(resolveInArch(project, '.')).toBeUndefined()
  })
})

describe('resolveInWorkspace', () => {
  it.each(ESCAPES)('refuses %s', (_case, attempt) => {
    expect(resolveInWorkspace(project, attempt)).toBeUndefined()
  })

  it('accepts a path outside .dsh but inside the workspace', () => {
    expect(resolveInWorkspace(project, 'docs/icons')).toBe(join(project, 'docs', 'icons'))
  })

  it('refuses the workspace root itself', () => {
    expect(resolveInWorkspace(project, '.')).toBeUndefined()
  })
})
