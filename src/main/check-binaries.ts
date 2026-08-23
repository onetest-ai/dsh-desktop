import { spawn as nodeSpawn } from 'node:child_process'
import { envWithLauncherDir, resolveBinary } from './server'

/** Outcome of checking one binary: the version it printed, or the real failure. */
export type BinaryCheckResult = { ok: true; version: string } | { ok: false; error: string }

/** The two Settings Advanced-tab binaries, checked together. */
export interface BinaryChecks {
  pnpm: BinaryCheckResult
  npm: BinaryCheckResult
}

/** `node:child_process`'s `spawn`, narrowed to what `checkBinary` calls; overridden in tests. */
export type SpawnFn = typeof nodeSpawn

/**
 * Run `<name> --version` exactly the way `dshWebCommand` would spawn it: through
 * the same `resolveBinary`/`envWithLauncherDir` pair, so a check that passes can
 * only mean the real launch would too.
 * @param configured - the path field's current form value; `undefined` (or
 *   empty, per the caller) means "resolve from PATH", matching `resolveBinary`.
 * @param name - the binary name (`pnpm` or `npm`), used both for PATH lookup
 *   and in the printed error.
 * @param env - the app's own environment; never mutated, only read.
 * @param timeoutMs - how long to wait before treating the child as hung.
 * @param spawnFn - the spawn implementation; overridden in tests.
 * @returns success with the trimmed version string the binary printed, or the
 *   real failure: `resolveBinary`'s own refusal, a spawn error, a non-zero
 *   exit with its stderr, or a timeout.
 */
export function checkBinary(
  configured: string | undefined,
  name: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  spawnFn: SpawnFn = nodeSpawn,
): Promise<BinaryCheckResult> {
  let command: string
  try {
    command = resolveBinary(configured, name, env)
  } catch (error) {
    return Promise.resolve({ ok: false, error: (error as Error).message })
  }

  // Same environment `dshWebCommand` spawns the real child with: an absolute
  // launcher is typically a `#!/usr/bin/env node` shebang script, and this is
  // what makes `node` findable one level down, in the shebang's own lookup.
  const childEnv = envWithLauncherDir(command, env) ?? env

  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<SpawnFn>
    try {
      child = spawnFn(command, ['--version'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: (error as Error).message })
      return
    }

    let stdout = ''
    let stderr = ''

    const finish = (result: BinaryCheckResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, error: `${name} --version did not respond within ${String(timeoutMs)}ms.` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (cause) => {
      finish({ ok: false, error: (cause as Error).message })
    })
    child.on('exit', (code) => {
      if (code === 0) finish({ ok: true, version: stdout.trim() || stderr.trim() })
      else finish({ ok: false, error: stderr.trim() || stdout.trim() || `${name} --version exited with code ${String(code)}` })
    })
  })
}

/**
 * Check both Advanced-tab binaries concurrently, against the form's current
 * values rather than the saved config — the point is to test a path before
 * committing to it.
 * @param pnpmPath - the pnpm path field's current value; blank means PATH.
 * @param npmPath - the npm path field's current value; blank means PATH.
 * @param env - the app's own environment; never mutated, only read.
 * @param timeoutMs - the per-binary timeout, shared by both checks.
 * @param spawnFn - the spawn implementation; overridden in tests.
 * @returns both outcomes, keyed by binary.
 */
export async function checkBinaries(
  pnpmPath: string,
  npmPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  spawnFn: SpawnFn = nodeSpawn,
): Promise<BinaryChecks> {
  const [pnpm, npm] = await Promise.all([
    checkBinary(pnpmPath.trim() === '' ? undefined : pnpmPath.trim(), 'pnpm', env, timeoutMs, spawnFn),
    checkBinary(npmPath.trim() === '' ? undefined : npmPath.trim(), 'npm', env, timeoutMs, spawnFn),
  ])
  return { pnpm, npm }
}
