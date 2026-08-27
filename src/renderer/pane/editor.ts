/** The file the editor currently holds. */
export interface OpenFile {
  root: string
  relative: string
}

/**
 * A mounted document.
 *
 * The editor library sits behind this: Monaco needs a real DOM, workers, and
 * a layout pass, none of which belong in the rules this class exists to
 * enforce — which file is open, whether it differs from disk, and what
 * happens when it changes underneath.
 */
export interface Surface {
  /** The current contents of the buffer. */
  text(): string
  /** Release the document and its editor. */
  destroy(): void
}

/** What the editor needs from main and from the editor library. */
export interface EditorDeps {
  readFile(root: string, relative: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
  writeFile(root: string, relative: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Report a message to the user, or clear it with `''`. */
  say(message: string): void
  /**
   * Put a document on screen, replacing any previous one.
   * @param text - the document's contents.
   * @param name - the file's path, which chooses the language.
   * @returns the mounted surface.
   */
  mount(text: string, name: string): Surface
}

/**
 * The pane's editor: one open file at a time.
 *
 * One at a time deliberately. Tabs within a tab are a second navigation model
 * beside the file tree, which already lists everything and remembers where
 * the user was.
 */
export class Editor {
  private surface: Surface | undefined
  private file: OpenFile | undefined
  /** The text as last read or written, which is what makes "dirty" answerable. */
  private saved = ''

  constructor(private readonly deps: EditorDeps) {}

  /** The file currently open, or undefined when none is. */
  get current(): OpenFile | undefined {
    return this.file
  }

  /** Whether the buffer differs from what is on disk. */
  get dirty(): boolean {
    return this.surface !== undefined && this.surface.text() !== this.saved
  }

  /**
   * Open a file, replacing whatever was open.
   * @param file - the file to open.
   * @returns resolution once it is mounted, or its failure reported.
   */
  async open(file: OpenFile): Promise<void> {
    const outcome = await this.deps.readFile(file.root, file.relative)
    if (!outcome.ok) {
      this.deps.say(outcome.reason)
      return
    }
    this.file = file
    this.saved = outcome.text
    this.surface?.destroy()
    this.surface = this.deps.mount(outcome.text, file.relative)
    this.deps.say(file.relative)
  }

  /**
   * Write the buffer back to disk.
   * @returns resolution once the write settled.
   */
  async save(): Promise<void> {
    if (this.file === undefined || this.surface === undefined) return
    const text = this.surface.text()
    const outcome = await this.deps.writeFile(this.file.root, this.file.relative, text)
    if (!outcome.ok) {
      this.deps.say(outcome.reason)
      return
    }
    this.saved = text
    this.deps.say(`Saved ${this.file.relative}`)
  }

  /**
   * Take a change made outside this editor.
   *
   * A clean buffer is replaced silently — that is the agent editing a file the
   * user happens to be looking at, and showing stale text would be a lie. A
   * dirty buffer is never overwritten: the user's unsaved work is the one
   * thing here that exists nowhere else.
   * @param file - the file that changed.
   * @returns resolution once reloaded, or the conflict reported.
   */
  async reload(file: OpenFile): Promise<void> {
    if (this.file === undefined) return
    if (this.file.root !== file.root || this.file.relative !== file.relative) return
    if (this.dirty) {
      this.deps.say(`${file.relative} changed on disk. Save to overwrite, or reopen it to discard your edits.`)
      return
    }
    await this.open(file)
  }
}
