import { execFile } from 'node:child_process'

/** What one git invocation reported back. */
export interface GitResult {
  code: number
  /** Raw, because porcelain `-z` output is NUL-delimited and not always UTF-8. */
  stdout: Buffer
  stderr: string
}

/** How long a git call may take before it is killed. */
const TIMEOUT_MS = 30_000

/**
 * The environment every git child runs in.
 *
 * All four entries are load-bearing. Without `GIT_TERMINAL_PROMPT` git blocks
 * asking for a username on a terminal this app does not have; without the ssh
 * pair it asks for a key passphrase instead, or raises a GUI prompt — and an
 * askpass inherited from the user's own shell would do the same. This app
 * deliberately supplies no askpass of its own: a credential it never sees is
 * one it cannot leak, which is the same choice the MCP token store made.
 * @param base - the environment to derive from, normally `process.env`.
 * @returns the environment for the child.
 */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never' } as NodeJS.ProcessEnv
  env.GIT_SSH_COMMAND = `${base.GIT_SSH_COMMAND ?? 'ssh'} -o BatchMode=yes`
  delete env.GIT_ASKPASS
  return env
}

/**
 * Run git, and report what it said.
 *
 * The only place in this app a git child is started, so the environment above
 * cannot be forgotten at one call site out of twenty. A non-zero exit is a
 * result rather than a throw: git says why on stderr, and the panel shows it.
 * @param cwd - the working directory, normally a repository.
 * @param args - the arguments, without the program name.
 * @param gitPath - the binary to run; `git` from `PATH` by default.
 * @returns the exit code and both streams.
 */
export async function runGit(cwd: string, args: string[], gitPath = 'git'): Promise<GitResult> {
  return await new Promise<GitResult>((resolve) => {
    execFile(
      gitPath,
      args,
      { cwd, env: gitEnv(process.env), timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: stdout as unknown as Buffer,
          stderr: (stderr as unknown as Buffer).toString('utf8'),
        })
      },
    )
  })
}
