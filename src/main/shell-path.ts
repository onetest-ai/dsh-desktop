import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * How long the login shell may take to report its PATH.
 *
 * Generous because an interactive login shell sources the user's whole rc
 * file — measured at roughly 2.6 seconds on a development machine with nvm
 * and Homebrew — and bounded because that shell runs on a path that must
 * never be able to hang the app's launch.
 */
export const SHELL_RESOLVE_TIMEOUT_MS = 10_000

/**
 * Runs the login shell and returns its stdout. Injected so tests never spawn
 * a real shell, whose output depends on the developer's own rc files.
 * @param shell - absolute path to the user's shell.
 * @param args - arguments to pass it.
 * @returns the command's stdout.
 */
export type ShellRunner = (shell: string, args: string[]) => string

/**
 * The cache file, beside `desktop.json`.
 *
 * A separate file because this is derived state the app rewrites on its own
 * schedule, while `desktop.json` is hand-edited and user-owned; mixing the
 * two would mean rewriting the user's config to refresh a cache.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute cache-file path.
 */
export function shellPathCachePath(dshHome: string): string {
  return join(dshHome, 'shell-path.json')
}

/** The cache document. `version` lets a later format reject this one outright. */
interface CacheDocument {
  version: 1
  path: string
  shell: string
  resolvedAt: string
}

/** The only format this version understands. */
const CURRENT_VERSION = 1

/**
 * Ask the user's login shell for its PATH.
 *
 * Interactive (`-i`) as well as login (`-l`), because version managers put
 * their initialization in `.zshrc`/`.bashrc` rather than `.zprofile`:
 * measured, a non-interactive login shell resolves in 132 ms but reports no
 * nvm directory at all, while the interactive one takes 2.6 seconds and
 * finds it. Correctness wins here; the cost is paid once and cached.
 *
 * Never throws. A shell that hangs, exits non-zero, or prints something that
 * is not a PATH yields undefined, and the caller keeps whatever it had.
 * @param shell - `$SHELL`, or undefined when the environment does not say.
 * @param run - runs the shell; injected for tests.
 * @returns the reported PATH, or undefined when it could not be established.
 */
export function resolveShellPath(shell: string | undefined, run: ShellRunner): string | undefined {
  if (shell === undefined || shell === '') return undefined
  let output: string
  try {
    output = run(shell, ['-ilc', 'echo $PATH'])
  } catch {
    // A timeout, a non-zero exit, or a shell that is not executable. All mean
    // the same thing to this function: no PATH was established.
    return undefined
  }
  // The last non-empty line: an rc file that prints a banner or a warning
  // puts it before the echoed value.
  const candidate = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1)
  if (candidate === undefined) return undefined
  // A PATH is absolute entries separated by colons. Requiring one absolute
  // entry rejects an rc file's error text ("command not found: nvm") without
  // trying to validate every directory, which would reject a legitimate PATH
  // naming a directory that does not exist yet.
  if (!candidate.split(':').some((entry) => entry.startsWith('/'))) return undefined
  return candidate
}

/**
 * Persist a resolved PATH.
 *
 * Owner-only: a PATH enumerates the user's toolchain directories, which is
 * not worth advertising to other accounts on the machine. The mode is set
 * again after the write because an already-existing file keeps its own.
 * @param file - the cache-file path.
 * @param path - the resolved PATH.
 * @param shell - the shell that produced it.
 * @param now - an ISO timestamp, passed in so the caller owns the clock.
 */
export function writeCachedShellPath(file: string, path: string, shell: string, now: string): void {
  const document: CacheDocument = { version: CURRENT_VERSION, path, shell, resolvedAt: now }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/**
 * Read the cached PATH.
 *
 * A missing, unreadable, malformed, or wrong-version cache reads as absent:
 * this is an optimization, and a broken one must degrade to "resolve again"
 * rather than to a failed launch.
 * @param file - the cache-file path.
 * @returns the cached PATH, or undefined.
 */
export function readCachedShellPath(file: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const document = parsed as Partial<CacheDocument>
  if (document.version !== CURRENT_VERSION) return undefined
  return typeof document.path === 'string' && document.path !== '' ? document.path : undefined
}

/**
 * The default runner: the real shell, bounded and given a minimal
 * environment so the result reflects the user's rc files rather than
 * whatever this process happens to have inherited.
 * @param shell - absolute path to the user's shell.
 * @param args - arguments to pass it.
 * @returns the command's stdout.
 */
export function runShell(shell: string, args: string[]): string {
  return execFileSync(shell, args, {
    encoding: 'utf8',
    timeout: SHELL_RESOLVE_TIMEOUT_MS,
    env: { HOME: process.env.HOME ?? '', TERM: 'xterm' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}
