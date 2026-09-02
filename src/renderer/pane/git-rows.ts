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

/**
 * How one row reads: the filename first, its directory after it.
 *
 * The name is what is being looked for and the directory is what
 * disambiguates it, which is the order VS Code uses and the reason it scans.
 * @param entry - the changed path.
 * @returns the row's text.
 */
export function label(entry: EntryView): string {
  const at = entry.path.lastIndexOf('/')
  const name = at === -1 ? entry.path : entry.path.slice(at + 1)
  if (entry.from !== undefined) return `${name} ← ${entry.from}`
  return at === -1 ? name : `${name} ${entry.path.slice(0, at)}`
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
