/** Which list an entry belongs in. */
export type Section = 'staged' | 'changed' | 'untracked'

/** One changed path, as the panel shows it. */
export interface GitEntry {
  path: string
  /** The porcelain letter: `M`, `A`, `D`, `R`, `C`, `U`, or `?`. */
  status: string
  /** Where a rename came from. */
  from?: string
}

/** A repository's state, as the panel draws it. */
export interface RepoStatus {
  branch: string
  ahead: number
  behind: number
  staged: GitEntry[]
  changed: GitEntry[]
  untracked: GitEntry[]
}

/** How many fixed fields precede the path in a `1` record. */
const ORDINARY_FIELDS = 8

/** How many precede it in a `2` record, which carries a rename score. */
const RENAME_FIELDS = 9

/** How many precede it in a `u` record, which carries three stages. */
const UNMERGED_FIELDS = 10

/**
 * The path at the end of a record, kept whole.
 *
 * Everything before it is a fixed number of space-separated fields, so the
 * path is what remains rather than the last word — a path may contain spaces,
 * and splitting on them would truncate it.
 * @param record - one porcelain record, without its NUL.
 * @param fields - how many fields precede the path.
 * @returns the path.
 */
function pathAfter(record: string, fields: number): string {
  let at = 0
  for (let field = 0; field < fields; field += 1) at = record.indexOf(' ', at) + 1
  return record.slice(at)
}

/**
 * Read `git status --porcelain=2 -z --branch`.
 *
 * Pure, and given bytes rather than a string: the output is NUL-delimited,
 * and a path is bytes the filesystem accepted rather than anything guaranteed
 * to be text. Nothing here spawns git, which is what lets every shape below
 * be tested against recorded output.
 *
 * A `2` record carries its original path as a further NUL-delimited field, so
 * the walk consumes two fields for one entry; a parser that treats every
 * field as a record reads that path as an entry of its own.
 * @param stdout - what git wrote.
 * @returns the repository's state.
 */
export function parseStatus(stdout: Buffer): RepoStatus {
  const status: RepoStatus = { branch: '', ahead: 0, behind: 0, staged: [], changed: [], untracked: [] }
  const records = stdout.toString('utf8').split('\0')
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at]
    if (record === '') continue
    if (record.startsWith('# branch.head ')) {
      status.branch = record.slice('# branch.head '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const [ahead, behind] = record.slice('# branch.ab '.length).split(' ')
      status.ahead = Number.parseInt(ahead, 10)
      status.behind = Math.abs(Number.parseInt(behind, 10))
    } else if (record.startsWith('1 ')) {
      const [staged, unstaged] = [record[2], record[3]]
      const path = pathAfter(record, ORDINARY_FIELDS)
      if (staged !== '.') status.staged.push({ path, status: staged })
      if (unstaged !== '.') status.changed.push({ path, status: unstaged })
    } else if (record.startsWith('2 ')) {
      const [staged, unstaged] = [record[2], record[3]]
      const path = pathAfter(record, RENAME_FIELDS)
      // The original path is the next field, not the next record.
      at += 1
      const from = records[at]
      if (staged !== '.') status.staged.push({ path, status: staged, from })
      if (unstaged !== '.') status.changed.push({ path, status: unstaged, from })
    } else if (record.startsWith('u ')) {
      // Neither staged nor merely changed: a conflict is shown as one.
      status.changed.push({ path: pathAfter(record, UNMERGED_FIELDS), status: 'U' })
    } else if (record.startsWith('? ')) {
      status.untracked.push({ path: record.slice(2), status: '?' })
    }
    // `!` is ignored, and ignored files are not shown.
  }
  return status
}
