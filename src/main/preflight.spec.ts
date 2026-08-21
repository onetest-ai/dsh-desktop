import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflight } from './preflight'

describe('preflight', () => {
  it('fails and names the path when the repo is absent', () => {
    const result = preflight('/definitely/not/here')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('/definitely/not/here')
  })

  it('fails naming the build command when apps/web/dist is absent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-desktop-repo-'))
    const result = preflight(repo)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('pnpm run build:web')
  })

  it('passes when the repo and the built frontend both exist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-desktop-repo-'))
    mkdirSync(join(repo, 'apps', 'web', 'dist'), { recursive: true })
    expect(preflight(repo)).toEqual({ ok: true })
  })
})
