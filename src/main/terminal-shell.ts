import { basename } from 'node:path'

/** What the terminal runs, and how it is described to the user. */
export interface Shell {
  /** Absolute path to the shell binary. */
  command: string
  /** Arguments it is started with. */
  args: string[]
  /** Where the choice came from, for the message shown when it will not start. */
  source: 'configured' | 'environment' | 'fallback'
}

/**
 * The shell used when neither the settings nor the environment name one.
 *
 * Only reached when `$SHELL` is unset, which happens for an app launched from
 * Finder on a system whose login shell was never recorded. macOS has shipped
 * zsh as the default login shell since Catalina.
 */
export const FALLBACK_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh'

/**
 * Arguments a login shell is started with.
 *
 * Interactive, so the user's own `.zshrc`/`.bashrc` runs and the terminal
 * behaves like the one they opened themselves. Not a login shell (`-l`): the
 * app already resolves the login `PATH` once at startup and passes it down, so
 * a second login initialization per terminal would cost seconds and change
 * nothing.
 */
export function argsFor(command: string): string[] {
  if (process.platform === 'win32') return []
  return basename(command) === 'fish' ? ['--interactive'] : ['-i']
}

/**
 * Decide which shell a terminal runs.
 *
 * The configured shell wins, then the login shell the environment reports,
 * then a platform default. VS Code's terminal is configurable for the same
 * reason: `$SHELL` is what the user logs in with, which is not always what
 * they want a terminal in their editor to run.
 * @param configured - the shell from settings, when set.
 * @param env - the environment to read `SHELL` from.
 * @returns the shell to run and where the choice came from.
 */
export function resolveShell(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Shell {
  const chosen = configured?.trim()
  if (chosen !== undefined && chosen !== '') {
    return { command: chosen, args: argsFor(chosen), source: 'configured' }
  }
  const login = env.SHELL?.trim()
  if (login !== undefined && login !== '') {
    return { command: login, args: argsFor(login), source: 'environment' }
  }
  return { command: FALLBACK_SHELL, args: argsFor(FALLBACK_SHELL), source: 'fallback' }
}

/**
 * Why a configured shell is not usable, or undefined when it is.
 *
 * Checked before the terminal is opened so the message names the setting
 * rather than surfacing a `posix_spawnp failed` from inside the pty.
 * @param command - the shell path to check.
 * @param isExecutableFile - whether a path is a file this process may execute.
 * @returns the reason, or undefined when it can run.
 */
export function shellProblem(
  command: string,
  isExecutableFile: (path: string) => boolean,
): string | undefined {
  if (!command.startsWith('/') && process.platform !== 'win32') {
    return `${command} is not an absolute path. Give the full path to the shell, as in /bin/bash.`
  }
  if (!isExecutableFile(command)) return `${command} is not an executable file.`
  return undefined
}
