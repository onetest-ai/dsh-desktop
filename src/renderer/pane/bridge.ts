import type { Project, TreeEntry } from './tree.ts'
import type { BranchRowView, RepoStatusView, RowGroup, StashRowView } from './git-rows.ts'
import type { EntityView } from './board-rows.ts'

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

/**
 * One test, and how much of what it validates passes.
 *
 * Declared here rather than imported from main's `board-ipc.ts`, for
 * `ProjectGitView`'s reason: the renderer never imports from `src/main`, and
 * this is the shape that crosses the bridge. It is structurally the same as
 * main's `TestWire`, which is what makes the two ends agree without a
 * conversion between them.
 */
export interface TestView {
  folderPath: string
  name: string
  /** The reverse of a workitem's chip: what this test proves, and how much holds. */
  validates: { pass: number; total: number }
}

/** A suite, its sub-suites, and the tests directly inside it. */
export interface SuiteView {
  path: string
  slug: string
  suites: SuiteView[]
  tests: TestView[]
}

/**
 * The whole board, as both of its views receive it.
 *
 * `present` is false for a project with no `.dsh/tasks/` at all, which is a
 * different thing from a board with nothing in it: one is worth offering to
 * start, the other is not. `project` separates a third state from both of
 * those — no project open at all, where advice about creating a campaign
 * would name a place that does not exist — and it is what each view compares
 * to know the board it is holding notes about has been replaced.
 */
export interface BoardViewData {
  project: string | undefined
  present: boolean
  campaigns: EntityView[]
  tests: SuiteView
  findings: { folderPath: string; says: string }[]
}

/**
 * One entity, with everything a detail draws.
 *
 * Declared here rather than imported from main's `board-ipc.ts`, for
 * `TestView`'s reason: the renderer never imports from `src/main`, and this is
 * the shape that crosses the bridge. It is structurally the same as main's
 * `EntityDetailWire`, which is what makes the two ends agree without a
 * conversion between them.
 */
export interface EntityDetailView {
  level: string
  folderPath: string
  name: string
  status: string
  /** The parent's folder path and name, for the line under the heading. Absent for a campaign and a test. */
  parent?: { folderPath: string; name: string }
  /** The lead paragraph. */
  description: string
  /**
   * `[{ heading, body }]` in the level's own order, blank ones included so the reader sees the shape.
   *
   * `stray` marks a section this level does not own — modelled elsewhere in the
   * schema, or modelled nowhere. It is drawn with a finding rather than
   * dropped: the file is the only place it can be fixed.
   */
  sections: { heading: string; body: string; stray?: boolean }[]
  criteria: { text: string; done: boolean }[]
  /** Children as rows: tasks, bugs and sub-missions. */
  children: { level: string; folderPath: string; name: string; status: string }[]
  /** What validates this workitem. `name` is the test's own name, resolved in main. */
  links: { test: string; name: string; result: string; comment: string; bug?: string }[]
  /** For a test: which workitems point at it, and with what verdict. */
  validates: { folderPath: string; name: string; result: string }[]
  /** The file to hand the editor when Open file is pressed. */
  file: string
}

/**
 * What one board write reports back.
 *
 * The folder path the store answers with is dropped on the way across: the
 * board redraws from a fresh read rather than from a write's answer, so a
 * path here would be a second, staler description of where the entity is.
 * A refusal carries a reason to show — except when the user answered a
 * confirmation with Cancel, where the reason is empty because they already
 * know why nothing happened.
 */
export type BoardResult = { ok: true } | { ok: false; reason: string }

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
      gitRowMenu(section: RowGroup['section']): Promise<string | undefined>
      stageFiles(repo: string, paths: string[]): Promise<GitResult>
      unstageFiles(repo: string, paths: string[]): Promise<GitResult>
      discardFiles(repo: string, tracked: string[], untracked: string[]): Promise<GitResult>
      commitFiles(repo: string, message: string, add: string[], keep: string[], staged: string[]): Promise<GitResult>
      // `blockedKind` says which of git's two refusals it was: an untracked
      // one is not cleared by a plain `git stash push`, so the offer the panel
      // draws for it has to stash differently and say so.
      checkoutBranch(
        repo: string,
        name: string,
        remote: boolean,
      ): Promise<GitResult & { blocked?: string[]; blockedKind?: 'tracked' | 'untracked' }>
      createBranch(repo: string, name: string): Promise<GitResult>
      // The sha of what was created comes back with it: `stash@{0}` is a
      // position, and anything else stashing in the same repository — the
      // agent in the terminal panel — moves every entry down one.
      pushStash(repo: string, message: string, untracked?: boolean): Promise<GitResult & { ref?: string }>
      applyStash(repo: string, ref: string, pop: boolean): Promise<GitResult>
      dropStash(repo: string, ref: string): Promise<GitResult>
      // `trouble` says which failure it was, so the note can offer the way
      // out of that particular one rather than a generic apology.
      gitRemote(
        repo: string,
        op: 'fetch' | 'pull' | 'push' | 'publish',
      ): Promise<GitResult & { trouble?: 'https' | 'publickey' | 'hostkey' | 'rejected' | 'no-upstream' }>
      cancelGitRemote(repo: string): void
      openGitTerminal(repo: string): void
      onDiffTexts(
        listener: (root: string, relative: string, original: string, modified: string, inline: boolean) => void,
      ): void
      readTasks(): Promise<BoardViewData>
      // One entity, read the same way the board is — so a detail and the card
      // it was opened from cannot disagree. Undefined when the board no
      // longer has that folder path, which is the detail's cue to fall back.
      readTaskDetail(folderPath: string): Promise<EntityDetailView | undefined>
      onTasksChanged(listener: () => void): void
      // The tree names a folder and main does the rest: which tab comes
      // forward and where the board scrolls to are main's, not this page's.
      revealOnBoard(folderPath: string): void
      // The file name comes from the entity's level, which the card knows and
      // the tree does not — the renderer holds a folder path and nothing else.
      openTaskFile(folderPath: string, file: string): void
      onReveal(listener: (folderPath: string) => void): void
      // The board's four writes. Each answers with what the store did, and
      // each leaves the redraw to the `tasks:changed` main sends afterwards:
      // the panel never moves a card on its own say-so, because the file is
      // the only thing that knows where a card is.
      createBoardEntity(level: string, parent: string, name: string, second: string): Promise<BoardResult>
      setBoardStatus(folderPath: string, status: string): Promise<BoardResult>
      // The second of the detail's two editable things. The index is the
      // criterion's position in the list the detail was drawn from, which is
      // the list the store parsed out of the same file — a text would be a
      // second way to name the same line, and the two could disagree.
      tickCriterion(folderPath: string, index: number, done: boolean): Promise<BoardResult>
      // Main confirms this one before the store is touched, the way
      // `git:discard` does, so the panel does not ask a second time. The name
      // goes with the path because the confirmation is read by a person: the
      // card says "Fix the login timeout" and only the folder knows
      // `fix-the-login-timeout`. Main still checks the path and nothing else.
      trashBoardEntity(folderPath: string, name: string): Promise<BoardResult>
      askTheme(): void
      onTheme(listener: (dark: boolean) => void): void
    }
  }
}

export {}
