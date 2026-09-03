/** One changed path, as the panel receives it. */
export interface EntryView {
  path: string
  status: string
  from?: string
}

/** A repository's state, as the panel receives it. */
export interface RepoStatusView {
  branch: string
  ahead: number
  behind: number
  staged: EntryView[]
  changed: EntryView[]
  untracked: EntryView[]
}

/** One section of a repository's rows. */
export interface RowGroup {
  section: 'staged' | 'changed' | 'untracked'
  title: string
  entries: EntryView[]
}

/** What each section is called, in the order they are read. */
const SECTIONS = [
  { section: 'staged' as const, title: 'Staged Changes' },
  { section: 'changed' as const, title: 'Changes' },
  { section: 'untracked' as const, title: 'Untracked' },
]

/**
 * The sections to draw for one repository.
 *
 * Sorted by path rather than by status, so a row does not jump as a file is
 * edited — a list that reorders under the pointer is one you click wrong.
 * An empty section is left out entirely: a heading with nothing under it is
 * noise in a panel that is read at a glance.
 * @param status - the repository's state.
 * @returns the sections that have anything in them.
 */
export function rowsFor(status: RepoStatusView): RowGroup[] {
  return SECTIONS.map(({ section, title }) => ({
    section,
    title,
    entries: [...status[section]].sort((left, right) => left.path.localeCompare(right.path)),
  })).filter((group) => group.entries.length > 0)
}

/** A row's two pieces: what it is, and what qualifies it. */
export interface RowParts {
  /** The filename, which is what the eye is looking for. */
  name: string
  /**
   * The directory it sits in, or where a rename came from. Empty at the root.
   *
   * Separate from the name so the row can weight them differently and so the
   * truncation falls here: joined into one string the filename would be the
   * first thing an ellipsis ate, which is the one part that must survive.
   */
  dir: string
}

/**
 * The two pieces one row is drawn from.
 *
 * A rename's origin takes the directory's place rather than sitting beside
 * it: both answer "which file is this, exactly", and a row carrying name,
 * folder and origin at once is three facts competing for one line.
 * @param entry - the changed path.
 * @returns the filename and what qualifies it.
 */
export function parts(entry: EntryView): RowParts {
  const at = entry.path.lastIndexOf('/')
  const name = at === -1 ? entry.path : entry.path.slice(at + 1)
  if (entry.from !== undefined) return { name, dir: `← ${entry.from}` }
  return { name, dir: at === -1 ? '' : entry.path.slice(0, at) }
}

/** The token each status is drawn in, defaulting to the modified colour. */
const COLOURS: Record<string, string> = {
  A: 'var(--dsh-git-added)',
  M: 'var(--dsh-git-modified)',
  D: 'var(--dsh-git-deleted)',
  '?': 'var(--dsh-git-untracked)',
}

/**
 * The colour for a status letter.
 * @param status - the porcelain letter.
 * @returns a CSS colour value.
 */
export function colourOf(status: string): string {
  return COLOURS[status] ?? COLOURS.M
}
