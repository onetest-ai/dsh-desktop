import type { Context } from '@deepseek-ai/cordis'
// Side-effect type-only import: pulls in the client runtime's `declare module`,
// which is what types `ctx.sessions` and `ctx.workspaces` on the context.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { appendToComposer } from './composer.ts'
import type { ComposerOptions, ComposeRequest, DesktopBridge } from './desktop.ts'

/**
 * The slices of the harness's client runtime this reads.
 *
 * Re-declared narrowly rather than imported from the runtime's contracts: this
 * file drives only a handful of verbs, and a small local face is both what the
 * tests stub and a record of exactly how much of the session/workspace domains
 * this touches. The real `ctx.sessions` / `ctx.workspaces` satisfy these.
 */
interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One row of the workspace list — a project the user has open. */
interface WorkspaceRow {
  workspaceId: string
  /** The project's directory; matched against a session's cwd to find its project. */
  path: string
  title: string
}

interface WorkspaceSnapshot {
  items: readonly WorkspaceRow[]
}

interface SessionSnapshot {
  current: string | undefined
  byId: Record<string, { cwd?: string }>
}

/** The one session verb pair this needs: send a prompt, run a slash command. */
interface SessionHandle {
  prompt(content: { type: 'text'; text: string }[], mode: 'queue' | 'steer'): Promise<unknown>
  command(line: string): Promise<unknown>
}

interface Sessions {
  list: Observable<SessionSnapshot>
  binding(id: string): { session: SessionHandle } | undefined
}

interface Workspaces {
  list: Observable<WorkspaceSnapshot>
  startSession(workspaceId?: string): void
}

/** The working directory of the session the user is looking at, if any. */
function currentCwd(list: SessionSnapshot): string | undefined {
  return list.current === undefined ? undefined : list.byId[list.current]?.cwd
}

/** The id of the project the current session runs in, resolved through its cwd. */
function currentWorkspaceId(sessions: Sessions, workspaces: Workspaces): string | undefined {
  const cwd = currentCwd(sessions.list.getSnapshot())
  if (cwd === undefined) return undefined
  return workspaces.list.getSnapshot().items.find((row) => row.path === cwd)?.workspaceId
}

/** The session face the user is looking at, or undefined when none is open. */
function currentSession(sessions: Sessions): SessionHandle | undefined {
  const { current } = sessions.list.getSnapshot()
  return current === undefined ? undefined : sessions.binding(current)?.session
}

/**
 * Wait for a session to become current, up to a short deadline.
 *
 * `startSession` is fire-and-forget: it kicks off connecting the workspace and
 * opening its session, but the list snapshot only carries the new current a
 * tick or two later. Rather than guess at the timing, subscribe and resolve on
 * the first snapshot that has one — with a deadline so a compose into a project
 * that never opens a session still returns (the caller then falls back to the
 * box rather than hanging).
 * @param sessions - the session service.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the session, or undefined if none arrived in time.
 */
function waitForSession(sessions: Sessions, timeoutMs = 3000): Promise<SessionHandle | undefined> {
  const already = currentSession(sessions)
  if (already !== undefined) return Promise.resolve(already)
  return new Promise((resolve) => {
    let settled = false
    const finish = (session: SessionHandle | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(session)
    }
    const unsubscribe = sessions.list.subscribe(() => {
      const session = currentSession(sessions)
      if (session !== undefined) finish(session)
    })
    const timer = setTimeout(() => finish(currentSession(sessions)), timeoutMs)
  })
}

/**
 * Build the projects (and, when reachable, models) the app may offer.
 *
 * The current project is the one whose directory is the open session's cwd —
 * the same derivation `followCurrentWorkspace` reports, read from the two
 * snapshots here so the marked row tracks whichever session is on stage.
 *
 * `models` is left off entirely: this runtime's contracts expose no model
 * *catalog* feed a plugin may read (only a per-session selection setter, which
 * the app drives blind via `/model`), so there is nothing truthful to list —
 * and the app hides the control on an absent field. Do not fabricate one.
 * @param workspaces - the workspace list snapshot.
 * @param sessions - the session list snapshot, for the current project.
 * @returns the options to report.
 */
function composerOptions(workspaces: WorkspaceSnapshot, sessions: SessionSnapshot): ComposerOptions {
  const cwd = currentCwd(sessions)
  return {
    workspaces: workspaces.items.map((row) => ({
      id: row.workspaceId,
      title: row.title,
      current: cwd !== undefined && row.path === cwd,
    })),
  }
}

/**
 * Report the composer options whenever the projects or the open session change.
 *
 * Both feeds matter: the workspace list changes when a project is added or
 * renamed, and the session list changes when the user switches which project's
 * session is on stage — either moves the `current` mark. Deduped on the
 * serialized options so the two feeds' constant churn (every token, every
 * title) does not redraw the app's dropdowns for no change.
 * @param workspaces - the workspace service.
 * @param sessions - the session service.
 * @param report - called with each distinct set of options.
 * @returns a function that stops reporting.
 */
function reportComposerOptions(
  workspaces: Workspaces,
  sessions: Sessions,
  report: (opts: ComposerOptions) => void,
): () => void {
  let last: string | undefined
  const check = (): void => {
    const opts = composerOptions(workspaces.list.getSnapshot(), sessions.list.getSnapshot())
    const serialized = JSON.stringify(opts)
    if (serialized === last) return
    last = serialized
    report(opts)
  }
  check()
  const stopWorkspaces = workspaces.list.subscribe(check)
  const stopSessions = sessions.list.subscribe(check)
  return () => {
    stopWorkspaces()
    stopSessions()
  }
}

/**
 * Run one compose request against the harness's real session APIs.
 *
 * The order is deliberate: switch project first (so the prompt lands in the
 * right session), then the model (best-effort — there is no contract setter, so
 * a `/model` command that the deployment does not understand must not sink the
 * whole compose), then either send the prompt or leave it in the box. If no
 * session can be resolved — nothing open, or a just-started one that never
 * arrived — the text goes into the composer instead, so it is never lost.
 */
async function runCompose(sessions: Sessions, workspaces: Workspaces, req: ComposeRequest): Promise<void> {
  const switched = req.workspaceId !== undefined && req.workspaceId !== currentWorkspaceId(sessions, workspaces)
  if (switched) workspaces.startSession(req.workspaceId)

  const session = switched ? await waitForSession(sessions) : currentSession(sessions)
  if (session === undefined) {
    appendToComposer(req.text)
    return
  }

  if (req.model !== undefined) {
    // Best-effort: the model may not be switchable in this deployment, and a
    // failed switch should still let the prompt through on the current model.
    try {
      await session.command(`/model ${req.model}`)
    } catch {
      /* ignore — the control degrades to a no-op. */
    }
  }

  if (req.send) {
    await session.prompt([{ type: 'text', text: req.text }], 'queue')
  } else {
    appendToComposer(req.text)
  }
}

/**
 * Wire the desktop app's mini-composer to the harness's session runtime.
 *
 * Two directions: the app pushes a built compose down (`onCompose`), which we
 * run through the real `prompt`/`command` verbs rather than by typing into and
 * clicking the page; and we push the projects it may offer up
 * (`reportComposerOptions`), so its dropdowns are real data. Both calls are
 * optional — a desktop older than this feature has neither, and then this does
 * nothing. The handler never throws: a compose that fails must not take the
 * plugin's fiber down with it.
 * @param ctx - the client context (`ctx.sessions`, `ctx.workspaces`).
 * @param bridge - the desktop app's bridge.
 */
export function startCompose(ctx: Context, bridge: DesktopBridge): void {
  const sessions: Sessions = ctx.sessions
  const workspaces: Workspaces = ctx.workspaces

  if (typeof bridge.onCompose === 'function') {
    bridge.onCompose((req) => {
      void runCompose(sessions, workspaces, req).catch((error: unknown) => {
        console.warn('dsh-desktop: compose failed', error)
      })
    })
  }

  // As an effect, so unloading the plugin disposes the subscriptions rather
  // than leaving them on services that outlive it (mirrors followCurrentWorkspace).
  ctx.effect(() =>
    reportComposerOptions(workspaces, sessions, (opts) => {
      bridge.reportComposerOptions?.(opts)
    }),
  )
}

export { composerOptions, reportComposerOptions, runCompose }
