import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRepos } from './git-find'

/** A temporary tree with a `.git` directory at each named path. */
function tree(...repos: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'git-find-'))
  for (const repo of repos) mkdirSync(join(root, repo, '.git'), { recursive: true })
  return root
}

describe('findRepos', () => {
  it('finds a repository at the root itself', () => {
    const root = tree('.')
    expect(findRepos(root)).toEqual([root])
  })

  it('finds repositories one level down when the root is not one', () => {
    const root = tree('alpha', 'beta')
    expect(findRepos(root).sort()).toEqual([join(root, 'alpha'), join(root, 'beta')])
  })

  // reason: a project that is itself a repository and holds checkouts is the
  // case that prompted scanning at all.
  it('finds the root and its children together', () => {
    const root = tree('.', 'inner')
    expect(findRepos(root).sort()).toEqual([root, join(root, 'inner')].sort())
  })

  // reason: a dependency tree holds hundreds of repositories nobody is
  // working in, and scanning it is slow as well as wrong.
  it('never looks inside node_modules', () => {
    const root = tree('node_modules/pkg')
    expect(findRepos(root)).toEqual([])
  })

  // reason: one level is the scan depth; deeper is a different feature.
  it('does not look two levels down', () => {
    const root = tree('outer/inner')
    expect(findRepos(root)).toEqual([])
  })

  it('reports nothing for a directory with no repositories', () => {
    expect(findRepos(tree())).toEqual([])
  })

  it('reports nothing for a path that does not exist', () => {
    expect(findRepos('/nowhere/at/all')).toEqual([])
  })
})
