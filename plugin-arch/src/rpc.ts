import { DiagramParseError } from './diagram.ts'
import { applyEdit, EditError, type EditOps } from './edit.ts'
import { IconError, listIcons } from './icons.ts'
import { StoreError, createDiagram, deleteDiagram, listDiagrams, readDiagram, writeDiagram } from './store.ts'

/**
 * The part of `ctx.workspaceRegistry` this needs.
 *
 * Re-declared narrowly rather than imported: the plugin should compile against
 * the shape it uses, so a change elsewhere in the registry cannot break this
 * build, and a test can supply two lines instead of a service.
 */
export interface WorkspaceLookup {
  get(id: string): { path: string } | undefined
}

/**
 * A structured failure.
 *
 * Shaped by the runtime, not by taste: `ConnectionRpcResult` requires
 * `{ code, message, details }`, and a bare string does not satisfy it. The code
 * is what a caller branches on; the message is what a human reads.
 *
 * `code` is one of: `unknown-workspace` (the payload's `workspaceId` does not
 * resolve), `bad-request` (a missing or malformed field the caller sent —
 * including an `EditError` or `IconError` raised while acting on it),
 * `unknown-endpoint` (no such endpoint on this channel), `store-error` (the
 * diagram store or a diagram file itself is the problem — a `StoreError` or a
 * `DiagramParseError`), or `internal` (this handler's own defect, such as a
 * cast that didn't hold — never the caller's fault, and not a storage
 * problem, so it must not be read as either).
 */
export interface ArchFailure {
  code: string
  message: string
  details: object
}

/** What every endpoint returns. Failures are values, never rejections. */
export type ArchResult = { ok: true; value: unknown } | { ok: false; error: ArchFailure }

/**
 * Build a failure result.
 * @param code - the stable, branchable reason.
 * @param message - the human-readable explanation.
 * @returns the failure result.
 */
function fail(code: string, message: string): ArchResult {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Read the workspace id from a payload.
 * @param payload - the decoded RPC payload.
 * @returns the id, or undefined when absent.
 */
function workspaceIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const id = (payload as Record<string, unknown>)['workspaceId']
  return typeof id === 'string' ? id : undefined
}

/**
 * Read a named string field.
 * @param payload - the decoded RPC payload.
 * @param key - the field name.
 * @returns the value, or undefined.
 */
function stringField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Build the `/arch` channel handler.
 *
 * The project directory is resolved from a workspace id, NEVER from the
 * payload. A path parameter on a loopback channel that writes files is an
 * arbitrary-write hole, and that today's only caller is the harness's own page
 * does not make it the only caller tomorrow. A `path` field in a payload is
 * silently ignored, not honoured.
 * @param workspaces - the workspace registry, narrowed to what this uses.
 * @returns a handler for `ctx.connection.rpc.handle('/arch', …)`.
 */
export function createArchHandler(
  workspaces: WorkspaceLookup,
): (endpoint: string, payload: unknown) => Promise<ArchResult> {
  return async (endpoint: string, payload: unknown): Promise<ArchResult> => {
    const workspaceId = workspaceIdOf(payload)
    if (workspaceId === undefined) return fail('bad-request', 'missing workspaceId')
    const workspace = workspaces.get(workspaceId)
    if (workspace === undefined) return fail('unknown-workspace', `unknown workspace "${workspaceId}"`)
    const project = workspace.path

    try {
      switch (endpoint) {
        case 'diagram/list':
          return { ok: true, value: listDiagrams(project) }
        case 'diagram/read': {
          const id = stringField(payload, 'id')
          if (id === undefined) return fail('bad-request', 'missing id')
          return { ok: true, value: readDiagram(project, id) }
        }
        case 'diagram/create': {
          const id = stringField(payload, 'id')
          const title = stringField(payload, 'title')
          if (id === undefined || title === undefined) return fail('bad-request', 'missing id or title')
          return { ok: true, value: createDiagram(project, id, title) }
        }
        case 'diagram/edit': {
          const id = stringField(payload, 'id')
          if (id === undefined) return fail('bad-request', 'missing id')
          const ops = (payload as Record<string, unknown>)['ops'] as EditOps | undefined
          const next = applyEdit(readDiagram(project, id), ops ?? {})
          writeDiagram(project, id, next)
          return { ok: true, value: next }
        }
        case 'diagram/write': {
          // The canvas writes whole diagrams; the agent never does.
          const id = stringField(payload, 'id')
          const diagram = (payload as Record<string, unknown>)['diagram']
          if (id === undefined || diagram === undefined) return fail('bad-request', 'missing id or diagram')
          writeDiagram(project, id, diagram as Parameters<typeof writeDiagram>[2])
          return { ok: true, value: null }
        }
        case 'diagram/delete': {
          const id = stringField(payload, 'id')
          if (id === undefined) return fail('bad-request', 'missing id')
          deleteDiagram(project, id)
          return { ok: true, value: null }
        }
        case 'icon/list':
          return { ok: true, value: listIcons(project, stringField(payload, 'query')) }
        default:
          return fail('unknown-endpoint', `unknown endpoint "${endpoint}"`)
      }
    } catch (error) {
      // Distinct kinds reach the user as distinct codes. The caller is usually
      // an agent deciding what to do next, and "your request was malformed"
      // and "the file on disk is broken" call for opposite responses — a single
      // catch-all told it neither. Anything unrecognised is `internal`, because
      // a TypeError from this handler's own casts is a bug here, not a storage
      // problem, and labelling it `store-error` sends the reader to the wrong file.
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof EditError) return fail('bad-request', message)
      if (error instanceof StoreError) return fail('store-error', message)
      if (error instanceof DiagramParseError) return fail('store-error', message)
      if (error instanceof IconError) return fail('bad-request', message)
      return fail('internal', message)
    }
  }
}
