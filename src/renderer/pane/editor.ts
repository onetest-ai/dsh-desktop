/** A file the editor has open. */
export interface OpenFile {
  root: string
  relative: string
}

/** One open document, as the editor library holds it. */
export interface Document {
  /** The current contents of the buffer. */
  text(): string
  /** What the user has selected in it, or '' when nothing is. */
  selection(): string
  /** Show this document, hiding whichever was showing. */
  activate(): void
  /** Release it. */
  destroy(): void
}

/**
 * The editor library, behind a seam.
 *
 * Monaco needs a real DOM, workers, and a layout pass, none of which belong
 * in the rules this class enforces — which files are open, which is showing,
 * whether one differs from disk, and what happens when one changes
 * underneath.
 */
export interface Documents {
  /**
   * Open a document.
   * @param text - its contents.
   * @param name - the file's path, which chooses the language.
   * @returns the document, not yet showing.
   */
  open(text: string, name: string): Document
  /**
   * Show a file that is not text — an image, a video, a PDF.
   * @param url - where the pane can load the file from.
   * @param name - the file's path, which chooses the viewer.
   * @returns the document, not yet showing.
   */
  openMedia(url: string, name: string): Document
  /**
   * Open two texts beside each other, read-only on both sides.
   * @param original - the left-hand text.
   * @param proposed - the right-hand text.
   * @param name - the file's path, which chooses the language.
   * @param inline - true for one pane rather than two; defaults to two, which
   *   is what an agent's proposal has always shown.
   * @returns the document, not yet showing.
   */
  openDiff(original: string, proposed: string, name: string, inline?: boolean): Document
}

/** What the editor needs from main and from the editor library. */
export interface EditorDeps {
  readFile(root: string, relative: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
  writeFile(root: string, relative: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Report a message to the user, or clear it with `''`. */
  say(message: string): void
  /** Redraw the tab strip; called whenever the open set or the active tab changes. */
  render(): void
  /** Close the editor column, when the last tab goes. */
  closeColumn(): void
  documents: Documents
}

/** How one tab is showing its file. */
export type TabMode =
  /** The file's text, editable and savable. */
  | 'edit'
  /** The file beside a proposed change, read-only on both sides. */
  | 'diff'
  /** An image, video, audio, or PDF: shown, never read as text. */
  | 'media'

/** One tab: a file, its document, and what was last read or written for it. */
export interface Tab {
  file: OpenFile
  document: Document
  /** The text as last read or written, which is what makes "dirty" answerable. */
  saved: string
  mode: TabMode
}

/**
 * The pane's editor: the open files, and which of them is showing.
 *
 * One document per file rather than one editor re-mounted per switch, so a
 * tab keeps its undo history and its scroll position — which is the whole
 * difference between tabs and a viewer that reloads.
 */
export class Editor {
  private readonly tabs: Tab[] = []
  private active: Tab | undefined

  constructor(private readonly deps: EditorDeps) {}

  /**
   * Every open tab, in the order they were opened.
   *
   * Named apart from `open()`: a getter and a method of one name cannot both
   * exist, and the method is the one callers reach for by that word.
   */
  get openTabs(): readonly Tab[] {
    return this.tabs
  }

  /** The file showing, or undefined when nothing is open. */
  get current(): OpenFile | undefined {
    return this.active?.file
  }

  /** Whether the showing tab differs from what is on disk. */
  get dirty(): boolean {
    return this.active !== undefined && this.isDirty(this.active)
  }

  /**
   * Whether one tab differs from what is on disk.
   * @param tab - the tab to ask about.
   * @returns whether it has unsaved edits.
   */
  isDirty(tab: Tab): boolean {
    return tab.mode === 'edit' && tab.document.text() !== tab.saved
  }

  /**
   * Open a file, or bring it forward when it is already open.
   * @param file - the file to open.
   * @returns resolution once it is showing, or its failure reported.
   */
  async open(file: OpenFile): Promise<void> {
    const already = this.find(file)
    if (already !== undefined && already.mode === 'edit') {
      this.show(already)
      return
    }
    const outcome = await this.deps.readFile(file.root, file.relative)
    if (!outcome.ok) {
      this.deps.say(outcome.reason)
      return
    }
    // A diff for this file is replaced rather than joined: two tabs for one
    // path, one of them read-only, is a puzzle rather than a convenience.
    if (already !== undefined) this.drop(already)
    this.add({
      file,
      document: this.deps.documents.open(outcome.text, file.relative),
      saved: outcome.text,
      mode: 'edit',
    })
  }

  /**
   * Show a file that is not text.
   *
   * Nothing is read: an image is shown from the file itself, so there is no
   * buffer to be dirty and nothing to save.
   * @param file - the file to show.
   * @param url - where the pane can load it from.
   */
  showMedia(file: OpenFile, url: string): void {
    const already = this.find(file)
    if (already !== undefined) {
      this.show(already)
      return
    }
    this.add({
      file,
      document: this.deps.documents.openMedia(url, file.relative),
      saved: '',
      mode: 'media',
    })
  }

  /**
   * Show a file beside the text an agent proposes for it.
   * @param file - the file being proposed against.
   * @param proposed - the text the agent proposes.
   * @returns resolution once it is showing, or its failure reported.
   */
  async showDiff(file: OpenFile, proposed: string): Promise<void> {
    const outcome = await this.deps.readFile(file.root, file.relative)
    if (!outcome.ok) {
      this.deps.say(outcome.reason)
      return
    }
    const already = this.find(file)
    // An unsaved edit is never taken away by an agent's proposal: the
    // proposal opens beside nothing, and the user's tab stays as it is.
    if (already !== undefined && this.isDirty(already)) {
      this.deps.say(`${file.relative} has unsaved edits, so the proposed change was not opened.`)
      return
    }
    if (already !== undefined) this.drop(already)
    this.add({
      file,
      document: this.deps.documents.openDiff(outcome.text, proposed, file.relative),
      saved: proposed,
      mode: 'diff',
    })
  }

  /**
   * Show a diff between two texts the caller already has.
   *
   * Unlike `showDiff`, neither side is read from disk and the file's own
   * editor tab is left alone — a git diff is a second view of a file rather
   * than a proposal to replace what the user is editing, so it neither
   * closes that tab nor refuses because it has unsaved edits.
   * @param file - which file the diff is about.
   * @param original - the left-hand text.
   * @param modified - the right-hand text.
   * @param inline - true for one pane rather than two.
   */
  showTexts(file: OpenFile, original: string, modified: string, inline: boolean): void {
    const already = this.findIn(file, 'diff')
    if (already !== undefined) this.drop(already)
    this.add({
      file,
      document: this.deps.documents.openDiff(original, modified, file.relative, inline),
      saved: modified,
      mode: 'diff',
    })
  }

  /**
   * Bring one tab forward.
   * @param tab - the tab to show.
   */
  show(tab: Tab): void {
    this.active = tab
    tab.document.activate()
    this.deps.say(tab.mode === 'diff' ? `Proposed change to ${tab.file.relative}` : tab.file.relative)
    this.deps.render()
  }

  /**
   * Close one tab, showing its neighbour.
   *
   * Closing the last one closes the column: an editor with nothing in it has
   * no reason to take width from the conversation beside it.
   * @param tab - the tab to close.
   */
  close(tab: Tab): void {
    const at = this.tabs.indexOf(tab)
    if (at === -1) return
    this.drop(tab)
    if (this.tabs.length === 0) {
      this.active = undefined
      this.deps.say('')
      this.deps.render()
      this.deps.closeColumn()
      return
    }
    // The neighbour to the right, or the new last one — what every editor
    // does, and what keeps the eye where the closed tab was.
    this.show(this.tabs[Math.min(at, this.tabs.length - 1)])
  }

  /**
   * Write the showing tab back to disk.
   * @returns resolution once the write settled.
   */
  async save(): Promise<void> {
    await this.saveTab(this.active)
  }

  /**
   * Write one file back to disk, if it is open here with unsaved edits.
   *
   * The tree is its own page and cannot see these buffers, so anything that
   * acts on a file as it stands — showing it in the web view, for one — has
   * to come through here first. A file that is not open, or open and clean,
   * is already what is on disk and needs no write.
   * @param root - the project the file is in.
   * @param relative - its path within the project.
   * @returns resolution once any write settled.
   */
  async saveIfDirty(root: string, relative: string): Promise<void> {
    const tab = this.tabs.find((each) => each.file.root === root && each.file.relative === relative)
    if (tab === undefined || !this.isDirty(tab)) return
    await this.saveTab(tab)
  }

  /**
   * Write one tab back to disk.
   * @param tab - the tab to write, or undefined for nothing to do.
   * @returns resolution once the write settled.
   */
  private async saveTab(tab: Tab | undefined): Promise<void> {
    if (tab === undefined) return
    if (tab.mode === 'diff') {
      // A diff is a change to look at before it happens. Saving from one
      // would write the agent's proposal as though the user had made it.
      this.deps.say('This is a proposed change. Open the file to edit it.')
      return
    }
    // Nothing was read, so there is nothing to write back.
    if (tab.mode === 'media') return
    const text = tab.document.text()
    const outcome = await this.deps.writeFile(tab.file.root, tab.file.relative, text)
    if (!outcome.ok) {
      this.deps.say(outcome.reason)
      return
    }
    tab.saved = text
    this.deps.say(`Saved ${tab.file.relative}`)
    this.deps.render()
  }

  /**
   * What the user has selected, or '' when nothing is.
   * @returns the selected text.
   */
  selection(): string {
    return this.active?.document.selection() ?? ''
  }

  /**
   * Take a change made outside this editor.
   *
   * A clean tab is replaced silently — that is the agent editing a file the
   * user happens to have open, and showing stale text would be a lie. A dirty
   * one is never overwritten: the user's unsaved work is the one thing here
   * that exists nowhere else. A tab that is not showing is reloaded just the
   * same, so bringing it forward does not surface text from before the change.
   * @param file - the file that changed.
   * @returns resolution once reloaded, or the conflict reported.
   */
  async reload(file: OpenFile): Promise<void> {
    const tab = this.find(file)
    // Only an editable tab holds text that could go stale: a diff is not a
    // view of the file as it is, and a media tab reads the file itself.
    if (tab === undefined || tab.mode !== 'edit') return
    if (this.isDirty(tab)) {
      this.deps.say(`${file.relative} changed on disk. Save to overwrite, or reopen it to discard your edits.`)
      return
    }
    const outcome = await this.deps.readFile(file.root, file.relative)
    if (!outcome.ok) {
      this.deps.say(outcome.reason)
      return
    }
    const showing = this.active === tab
    const at = this.tabs.indexOf(tab)
    this.drop(tab)
    const replacement: Tab = {
      file,
      document: this.deps.documents.open(outcome.text, file.relative),
      saved: outcome.text,
      mode: 'edit',
    }
    // Put back exactly where it was, so a reload does not reorder the strip
    // under the user.
    this.tabs.splice(at, 0, replacement)
    if (showing) this.show(replacement)
    else this.deps.render()
  }

  /**
   * The tab holding a file, if one does.
   * @param file - the file to look for.
   * @returns its tab, or undefined.
   */
  private find(file: OpenFile): Tab | undefined {
    return this.tabs.find((tab) => tab.file.root === file.root && tab.file.relative === file.relative)
  }

  /**
   * The tab for one file in one mode.
   *
   * A file may have an editor tab and a git diff tab open at once, so the
   * mode is part of a tab's identity: looking one up by path alone would
   * return whichever was opened first and close the wrong one.
   * @param file - the file to look for.
   * @param mode - which of its tabs is wanted.
   * @returns the tab, or undefined.
   */
  private findIn(file: OpenFile, mode: Tab['mode']): Tab | undefined {
    return this.tabs.find(
      (tab) => tab.file.root === file.root && tab.file.relative === file.relative && tab.mode === mode,
    )
  }

  /**
   * Add a tab and show it.
   * @param tab - the tab to add.
   */
  private add(tab: Tab): void {
    this.tabs.push(tab)
    this.show(tab)
  }

  /**
   * Remove a tab and release its document.
   * @param tab - the tab to remove.
   */
  private drop(tab: Tab): void {
    const at = this.tabs.indexOf(tab)
    if (at !== -1) this.tabs.splice(at, 1)
    tab.document.destroy()
    if (this.active === tab) this.active = undefined
  }
}
