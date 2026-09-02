// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The panel's markup, cut to the two elements it writes into.
 *
 * `git.html` declares more, but nothing else is read by name: a fuller copy
 * here would be a second description of the page that could drift from it.
 */
function page(): void {
  document.body.innerHTML = '<p class="empty" id="git-empty" hidden></p><div id="repos"></div>'
}

/**
 * Load the panel with a bridge that answers `readGit` as told.
 *
 * The module reads once as it loads, so it is imported per test rather than
 * once for the file.
 * @param readGit - the bridge call the panel's refresh goes through.
 * @returns resolution once that first read has been drawn.
 */
async function load(readGit: () => Promise<unknown>): Promise<void> {
  ;(globalThis as unknown as { pane: unknown }).pane = {
    readGit,
    onGitChanged: () => {},
    openGitDiff: () => {},
    askTheme: () => {},
    onTheme: () => {},
  }
  vi.resetModules()
  await import('./git.ts')
  // The load-time read, and the draw that follows it.
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/** What the panel is saying when it has nothing to list. */
function empty(): { text: string; hidden: boolean } {
  const node = document.getElementById('git-empty') as HTMLElement
  return { text: node.textContent ?? '', hidden: node.hidden }
}

describe('the git panel', () => {
  beforeEach(() => {
    page()
  })

  it('words the state when the project holds no repository', async () => {
    await load(async () => ({ ok: true, repos: [] }))
    expect(empty()).toEqual({ text: 'No repository in this project.', hidden: false })
  })

  // reason: nothing on the other side of the bridge rejects today, so without
  // this the failure path is not merely untested but unwritten: `latest`
  // would stay unset, `draw` would keep the empty state hidden, and the panel
  // would be a blank column with no message and no way to ask again.
  it('says so when the read fails rather than staying blank', async () => {
    await load(async () => {
      throw new Error('the channel is gone')
    })
    expect(empty().hidden).toBe(false)
    expect(empty().text).toContain('the channel is gone')
  })
})
