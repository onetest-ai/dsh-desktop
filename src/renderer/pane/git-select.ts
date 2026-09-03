import type { RepoStatusView } from './git-rows.ts'

/** The three sections a tick can live in, matching `RowGroup['section']`. */
export type Section = 'staged' | 'changed' | 'untracked'

/** Sections whose rows start ticked: everything git already knows about. */
const TRACKED: readonly Section[] = ['staged', 'changed']

/** The paths one section of a repository's status lists, each once. */
function pathsOf(status: RepoStatusView, section: Section): string[] {
  return status[section].map((entry) => entry.path)
}

/**
 * Which files are ticked, per repository and per section.
 *
 * The tick is a selection rather than the index: it says only *include this
 * in the next commit*, and nothing runs until Commit is pressed. Held in the
 * page rather than on disk — a selection is about the commit being composed
 * right now, and one restored from a previous session would be a claim about
 * files the user has not looked at.
 *
 * A tick is keyed by (repo, section, path) rather than (repo, path). A file
 * staged and then edited again lists in both **Staged Changes** and
 * **Changes** at once, and the two rows mean different content — the staged
 * row is the version already recorded, the changed row the edits made since.
 * Collapsing them to one key per path would make ticking one row also tick
 * the other, which is not what either checkbox means.
 */
export class Selection {
  /** Ticked paths, by repository and then by section. */
  private readonly ticks = new Map<string, Map<Section, Set<string>>>()

  /** Paths already reconciled once, by repository and section, so a default is applied only on arrival. */
  private readonly seen = new Map<string, Map<Section, Set<string>>>()

  /** The tick set for one (repo, section), creating it on first use. */
  private ticksFor(repo: string, section: Section): Set<string> {
    const bySection = this.ticks.get(repo) ?? new Map<Section, Set<string>>()
    this.ticks.set(repo, bySection)
    const set = bySection.get(section) ?? new Set<string>()
    bySection.set(section, set)
    return set
  }

  /**
   * Whether one path's row in one section is ticked.
   * @param repo - the repository's path.
   * @param section - which row — a path in two sections keeps two ticks.
   * @param path - the file's path within the repository.
   * @returns whether that row would be committed.
   */
  ticked(repo: string, section: Section, path: string): boolean {
    return this.ticks.get(repo)?.get(section)?.has(path) ?? false
  }

  /**
   * Turn one path's tick in one section over.
   * @param repo - the repository's path.
   * @param section - which row to flip.
   * @param path - the file's path within the repository.
   */
  toggle(repo: string, section: Section, path: string): void {
    const set = this.ticksFor(repo, section)
    if (set.has(path)) set.delete(path)
    else set.add(path)
  }

  /**
   * Tick or clear every path in one section at once.
   * @param repo - the repository's path.
   * @param section - which section the header governs.
   * @param paths - the paths currently listed in that section.
   * @param on - true to tick them, false to clear them.
   */
  setSection(repo: string, section: Section, paths: string[], on: boolean): void {
    const set = this.ticksFor(repo, section)
    for (const path of paths) {
      if (on) set.add(path)
      else set.delete(path)
    }
  }

  /**
   * The paths to stage, and the paths already staged that must be left alone.
   *
   * `add` is every path whose changed or untracked row is ticked, each once
   * even when it is ticked in both. `keep` is every path whose staged row is
   * ticked *and* whose changed row is not: staging it again would run `git
   * add` against the newer working-tree content and silently overwrite the
   * version the staged tick exists to preserve, so a path in `add` never
   * also appears in `keep`.
   * @param repo - the repository's path.
   * @param status - its current state.
   * @returns the paths to `git add`, and the already-staged paths to leave untouched.
   */
  selected(repo: string, status: RepoStatusView): { add: string[]; keep: string[] } {
    const changed = pathsOf(status, 'changed').filter((path) => this.ticked(repo, 'changed', path))
    const untracked = pathsOf(status, 'untracked').filter((path) => this.ticked(repo, 'untracked', path))
    const add = [...new Set([...changed, ...untracked])]
    const addSet = new Set(add)
    const keep = pathsOf(status, 'staged').filter((path) => this.ticked(repo, 'staged', path) && !addSet.has(path))
    return { add, keep }
  }

  /**
   * Bring one section's ticks in line with a fresh status.
   * @param repo - the repository's path.
   * @param section - the section to reconcile.
   * @param paths - the paths that section currently lists.
   */
  private reconcileSection(repo: string, section: Section, paths: string[]): void {
    const present = new Set(paths)
    const bySeen = this.seen.get(repo) ?? new Map<Section, Set<string>>()
    this.seen.set(repo, bySeen)
    const seen = bySeen.get(section) ?? new Set<string>()
    bySeen.set(section, seen)
    const set = this.ticksFor(repo, section)
    for (const path of present) {
      if (seen.has(path)) continue
      if (TRACKED.includes(section)) set.add(path)
      seen.add(path)
    }
    for (const path of [...seen]) if (!present.has(path)) seen.delete(path)
    for (const path of [...set]) if (!present.has(path)) set.delete(path)
  }

  /**
   * Bring the ticks of every section in line with a fresh status.
   *
   * A path arriving in a section for the first time takes that section's
   * default: staged and changed rows start ticked, untracked rows do not,
   * because committing a file nobody noticed is how build output and
   * credentials reach a repository. A path that has left a section is
   * forgotten there entirely, so a file of the same name appearing later in
   * that section does not inherit a decision made about a different one.
   * @param repo - the repository's path.
   * @param status - its current state.
   */
  reconcile(repo: string, status: RepoStatusView): void {
    this.reconcileSection(repo, 'staged', pathsOf(status, 'staged'))
    this.reconcileSection(repo, 'changed', pathsOf(status, 'changed'))
    this.reconcileSection(repo, 'untracked', pathsOf(status, 'untracked'))
  }
}
