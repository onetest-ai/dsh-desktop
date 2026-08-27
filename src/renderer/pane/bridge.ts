import type { Project, TreeEntry } from './tree.ts'

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
      projects(): Promise<Project[]>
      listDirectory(root: string, relative: string): Promise<TreeEntry[]>
      openFile(root: string, relative: string): void
      closeEditor(): void
      openExternal(url: string): void
      readFile(root: string, relative: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
      writeFile(root: string, relative: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>
      onOpenFile(listener: (root: string, relative: string) => void): void
      onFileChanged(listener: (root: string, relative: string) => void): void
      onShowDiff(listener: (root: string, relative: string, proposed: string) => void): void
      onShowWeb(listener: () => void): void
      navigate(url: string): void
      webBack(): void
      webForward(): void
      webReload(): void
      onWebState(listener: (state: { url: string; canGoBack: boolean; canGoForward: boolean }) => void): void
      askTheme(): void
      onTheme(listener: (preference: string) => void): void
    }
  }
}

export {}
