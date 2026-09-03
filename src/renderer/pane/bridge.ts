import type { Project, TreeEntry } from './tree.ts'
import type { BranchRowView, RepoStatusView, RowGroup, StashRowView } from './git-rows.ts'

/**
 * What the git panel is showing, or why it is showing nothing.
 *
 * Declared here rather than imported from main's `git-model.ts`: the renderer
 * never imports from `src/main`, and this is the shape that crosses the
 * bridge, not main's own model.
 */
export type ProjectGitView =
  | {
      ok: true
      repos: { path: string; name: string; status: RepoStatusView; branches: BranchRowView[]; stashes: StashRowView[] }[]
    }
  | { ok: false; reason: string }

/**
 * What one git write reports back.
 *
 * Declared here rather than imported from main's `ActionOutcome`: the renderer
 * never imports from `src/main`, and this is the shape that crosses the
 * bridge. A refusal carries a reason to show — except when the user answered a
 * confirmation with Cancel, where the reason is empty because they already
 * know why nothing happened.
 */
export type GitResult = { ok: true } | { ok: false; reason: string }

/** What an operation on one entry reports back. */
export type OpResult = { ok: true; relative: string } | { ok: false; reason: string }

/**
 * What the preload exposes to both of this app's own pages.
 *
 * One declaration for both: they share a preload, so a page-local view of it
 * would be a second description of the same object — and the two would drift.
 */
declare global {
  interface Window {
    pane: {
      showWebView(visible: boolean): void
      askProject(): void
      onProject(listener: (project: Project | undefined) => void): void
      onProjectChanged(listener: (root: string, relative: string) => void): void
      listDirectory(root: string, relative: string): Promise<TreeEntry[]>
      openFile(root: string, relative: string): void
      createFile(root: string, relative: string): Promise<{ ok: true; relative: string } | { ok: false; reason: string }>
      createFolder(root: string, relative: string): Promise<{ ok: true; relative: string } | { ok: false; reason: string }>
      treeMenu(target: { directory: boolean; pending: boolean; name: string }): Promise<string | undefined>
      renameEntry(root: string, relative: string, name: string): Promise<OpResult>
      deleteEntry(root: string, relative: string, directory: boolean): Promise<OpResult>
      pasteEntry(root: string, relative: string, into: string, move: boolean): Promise<OpResult>
      openInWeb(root: string, relative: string): void
      loadInWeb(root: string, relative: string): void
      onSaveForWeb(listener: (root: string, relative: string) => void): void
      revealEntry(root: string, relative: string): void
      copyPath(root: string, relative: string): void
      addToChat(root: string, relative: string, directory: boolean): void
      closeEditor(): void
      openExternal(url: string): void
      readFile(root: string, relative: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
      writeFile(root: string, relative: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>
      onOpenFile(listener: (root: string, relative: string, url: string) => void): void
      onFileChanged(listener: (root: string, relative: string) => void): void
      onShowDiff(listener: (root: string, relative: string, proposed: string) => void): void
      onShowWeb(listener: () => void): void
      navigate(url: string): void
      webBack(): void
      webForward(): void
      webReload(): void
      onWebState(listener: (state: { url: string; canGoBack: boolean; canGoForward: boolean }) => void): void
      readGit(): Promise<ProjectGitView>
      onGitChanged(listener: () => void): void
      openGitDiff(repo: string, path: string, section: RowGroup['section']): void
      stageFiles(repo: string, paths: string[]): Promise<GitResult>
      unstageFiles(repo: string, paths: string[]): Promise<GitResult>
      discardFiles(repo: string, tracked: string[], untracked: string[]): Promise<GitResult>
      commitFiles(repo: string, message: string, add: string[], keep: string[], staged: string[]): Promise<GitResult>
      checkoutBranch(repo: string, name: string, remote: boolean): Promise<GitResult & { blocked?: string[] }>
      createBranch(repo: string, name: string): Promise<GitResult>
      pushStash(repo: string, message: string): Promise<GitResult>
      applyStash(repo: string, ref: string, pop: boolean): Promise<GitResult>
      dropStash(repo: string, ref: string): Promise<GitResult>
      onDiffTexts(
        listener: (root: string, relative: string, original: string, modified: string, inline: boolean) => void,
      ): void
      askTheme(): void
      onTheme(listener: (dark: boolean) => void): void
    }
  }
}

export {}
