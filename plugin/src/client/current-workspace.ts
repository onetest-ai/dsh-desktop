/** The part of the harness's session list this reads. */
export interface SessionList {
  current: string | undefined
  byId: Record<string, { cwd?: string }>
}

/** An observable the harness's client runtime exposes. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/**
 * The working directory of the session the user is looking at.
 * @param list - the harness's session list snapshot.
 * @returns its `cwd`, or undefined when nothing is open or it has none.
 */
export function currentCwd(list: SessionList): string | undefined {
  const current = list.current
  return current === undefined ? undefined : list.byId[current]?.cwd
}

/**
 * Report the session's working directory whenever it changes.
 *
 * The harness knows which session is open; this reports it rather than
 * leaving the desktop app to infer it from files on disk, which only move
 * when a session is created or writes something — not when the user simply
 * switches to one.
 *
 * Only on change, and only when there is one: the list fires for every
 * message, title, and token that lands, and re-sending the same directory
 * would redraw a file tree under the user for no reason.
 * @param sessions - the harness's session list observable.
 * @param report - called with each new working directory.
 * @returns a function that stops reporting.
 */
export function followCurrentWorkspace(
  sessions: Observable<SessionList>,
  report: (cwd: string) => void,
): () => void {
  let last: string | undefined
  const check = (): void => {
    const cwd = currentCwd(sessions.getSnapshot())
    if (cwd === undefined || cwd === last) return
    last = cwd
    report(cwd)
  }
  check()
  return sessions.subscribe(check)
}
