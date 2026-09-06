/**
 * What makes one inline-edit field, handed to {@link editField}.
 *
 * `onSave` is the only way this module talks to the world — it takes no
 * bridge and knows no `folderPath`, so a caller decides what "save" means
 * (a description patch, a section body, anything). `multiline` defaults to
 * true because most of what this draws is prose (a description, a section
 * body); a caller wiring up a one-line value (a document's label, say) sets
 * it false to get Enter-commits instead of Enter-inserts-a-newline.
 */
export interface EditFieldOptions {
  /** The current value, shown as read text and loaded into the textarea when opened. */
  value: string
  /** Shown, muted, in place of an empty value; also the textarea's placeholder. */
  placeholder: string
  /** Called once, on blur, with the new value — only when it differs from what was last saved. */
  onSave: (next: string) => void
  /** False makes Enter commit (blur) rather than insert a newline. Default true. */
  multiline?: boolean
}

/**
 * Text that becomes an autosizing textarea on click and saves on blur.
 *
 * Modelled on octoshell's `Field`/`AutoTextarea`: read state shows plain text
 * (the caller renders markdown itself, before handing in `value`, if it wants
 * that — this module only ever deals in the raw string), click swaps in a
 * `<textarea>` seeded with that same raw string, and blur is the only save
 * point. Blur firing on every stray focus loss is the reason a same-value
 * blur must be a no-op rather than a fire-and-let-the-caller-dedupe: this
 * board's detail is re-read and redrawn after every save, so a spurious call
 * would round-trip to main and back for nothing. Escape reverts without
 * saving, for the same reason a text editor's Escape does — the field is a
 * small commit, and a small commit needs a way to back out of it.
 *
 * The element returned is the whole control's root; it replaces its own
 * children in place on each transition; nothing above it needs to redraw.
 * @param opts - value, placeholder, save callback, and the multiline switch.
 * @returns the field's root element, read state showing first.
 */
export function editField(opts: EditFieldOptions): HTMLElement {
  const { value, placeholder, onSave, multiline = true } = opts
  let saved = value

  const root = document.createElement('div')
  root.className = 'edit-field'

  const resize = (textarea: HTMLTextAreaElement): void => {
    // Auto first, so shrinking the text shrinks the box — scrollHeight only
    // grows to fit what's already there if the height isn't reset first.
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }

  const showRead = (text: string): void => {
    root.replaceChildren()
    const read = document.createElement('div')
    read.className = 'edit-field-read'
    read.tabIndex = 0
    read.setAttribute('role', 'button')
    if (text.length === 0) {
      read.classList.add('edit-field-empty')
      read.textContent = placeholder
    } else {
      read.textContent = text
    }
    const open = (): void => showEdit()
    read.addEventListener('click', open)
    read.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
    root.appendChild(read)
  }

  const showEdit = (): void => {
    root.replaceChildren()
    const textarea = document.createElement('textarea')
    textarea.className = 'edit-field-input'
    textarea.placeholder = placeholder
    textarea.value = saved
    if (!multiline) textarea.rows = 1

    // Escape sets this before it swaps the DOM back to read state, so the
    // blur that removing a focused element may raise finds a field already
    // reverted and does nothing — a fired blur must never re-open the save
    // path Escape was called to avoid.
    let reverted = false

    textarea.addEventListener('input', () => resize(textarea))
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        reverted = true
        showRead(saved)
      } else if (e.key === 'Enter' && !multiline && !e.shiftKey) {
        e.preventDefault()
        textarea.blur()
      }
    })
    textarea.addEventListener('blur', () => {
      if (reverted) return
      const next = textarea.value
      if (next !== saved) {
        saved = next
        onSave(next)
      }
      // The board re-reads and redraws after a save, so the read text this
      // shows next will be replaced with the store's own copy shortly — this
      // revert is only so the control isn't left as a bare textarea in the
      // gap between blur and that redraw (or forever, if the save is a no-op
      // this caller chooses to swallow).
      showRead(saved)
    })

    root.appendChild(textarea)
    resize(textarea)
    textarea.focus()
  }

  showRead(saved)
  return root
}
