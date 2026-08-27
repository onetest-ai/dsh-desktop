import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMcpConfig, type McpServerEntry } from './mcp-config'

/** One project the harness has opened, with the MCP servers that project declares. */
export interface WorkspaceMcp {
  /** The project directory. */
  path: string
  /** The harness's own name for it, usually the directory's basename. */
  title: string
  /** Where this project's servers are declared, whether or not the file exists. */
  file: string
  /** Whether that file exists; an absent file is the normal case, not a fault. */
  declared: boolean
  /** The declared servers, empty when the file is absent or unusable. */
  servers: McpServerEntry[]
}

/**
 * The harness's workspace storage.
 *
 * Read, never written: this file belongs to the harness, and this app only
 * needs the list of projects the user has opened so it can show what each one
 * declares.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute `workspace.json` path.
 */
export function workspacesPath(dshHome: string): string {
  return join(dshHome, 'storages', 'workspace.json')
}

/**
 * Where a project declares its own MCP servers.
 *
 * The path `dsh-project-mcp-bridge` reads per session, so what this app shows
 * is the file that plugin will actually load.
 * @param workspacePath - the project directory.
 * @returns the absolute `mcp.json` path inside it.
 */
export function projectMcpPath(workspacePath: string): string {
  return join(workspacePath, '.dsh', 'mcp.json')
}

/**
 * Read one workspace record, or undefined when it is not one.
 *
 * The storage format belongs to the harness and may change under this app, so
 * every field is checked rather than assumed: an unrecognized record is
 * skipped and the rest of the list still renders.
 * @param value - one entry of the `workspaces` table.
 * @returns the path, title, and last-used stamp, or undefined.
 */
function workspaceRecord(value: unknown): { path: string; title: string; updatedAt: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { path, title, updatedAt } = value as Record<string, unknown>
  if (typeof path !== 'string' || path === '') return undefined
  return {
    path,
    title: typeof title === 'string' && title !== '' ? title : path,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  }
}

/**
 * List the projects the harness has opened, most recently used first.
 *
 * Most-recent-first because the list stands in for "the project I am working
 * in": the harness records no current workspace, and its own `updatedAt` is
 * the closest thing to one.
 *
 * A missing, unreadable, or unrecognized storage file reads as no workspaces.
 * This is a view of someone else's file — it must never be able to break the
 * Settings window that displays it.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns one entry per workspace, with that project's declared servers.
 */
export function readWorkspaces(dshHome: string): WorkspaceMcp[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(workspacesPath(dshHome), 'utf8'))
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const tables = (parsed as Record<string, unknown>).tables
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return []
  const workspaces = (tables as Record<string, unknown>).workspaces
  if (workspaces === null || typeof workspaces !== 'object' || Array.isArray(workspaces)) return []

  const records = Object.values(workspaces as Record<string, unknown>)
    .map(workspaceRecord)
    .filter((record): record is { path: string; title: string; updatedAt: string } => record !== undefined)
  records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return records.map(({ path, title }) => {
    const file = projectMcpPath(path)
    return { path, title, file, declared: existsSync(file), servers: readMcpConfig(file) }
  })
}
