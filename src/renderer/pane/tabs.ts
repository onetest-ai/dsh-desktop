/**
 * Which surface the editor column is showing.
 *
 * The file tree is not among them: it is a column of its own, beside this
 * one, the way an IDE keeps its explorer.
 */
export type PaneTab = 'editor' | 'web'

/** Every tab, in the order they appear. */
export const PANE_TABS: readonly PaneTab[] = ['editor', 'web']

/** What the pane's DOM needs to change when the tab changes. */
export interface TabView {
  /** Mark one tab button current and the rest not. */
  select(tab: PaneTab): void
  /** Show one panel and hide the rest. */
  reveal(tab: PaneTab): void
  /**
   * Tell main whether the web view should be on screen.
   *
   * The web view is a `WebContentsView` stacked over the pane's own bounds,
   * not an element in this document — so hiding the Web panel here would
   * leave it covering whichever panel took its place.
   */
  showWebView(visible: boolean): void
}

/**
 * Move the pane to a tab.
 *
 * Kept apart from the DOM so the rule that matters — the web view follows
 * the tab, and only the Web tab — is testable without a document.
 * @param tab - the tab to move to.
 * @param view - what to change.
 */
export function selectTab(tab: PaneTab, view: TabView): void {
  view.select(tab)
  view.reveal(tab)
  view.showWebView(tab === 'web')
}
