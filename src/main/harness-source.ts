import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the harness runtime comes from. */
export type HarnessSource =
  | { kind: 'local'; repo: string }
  | { kind: 'npx'; package: string; version: string; workspace: string }

/** Resolved binaries used to launch each source kind. */
export interface Launchers {
  pnpm: string
  npx: string
}

/** Spawn specification shared with `server.ts`. */
export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

/** The harness home directory name, mirroring `dsh`'s own convention. */
const HOME_DIR_NAME = '.dsh'

/**
 * Absolute path of the desktop config file.
 * Lives under `$DSH_HOME` so a packaged app — which cannot edit its own
 * bundle — reads the same location the harness itself uses.
 * @param env - environment to read `DSH_HOME` from.
 * @returns the config file path.
 */
export function configPath(env: NodeJS.ProcessEnv): string {
  const raw = env.DSH_HOME
  // Matches the harness's own `resolveDshHome` (packages/util/home-paths):
  // trimming only decides whether the value counts as set; the value used is
  // the original, untrimmed string.
  const isSet = raw !== undefined && raw.trim().length > 0
  const home = isSet ? raw : join(homedir(), HOME_DIR_NAME)
  return join(home, 'desktop.json')
}

/**
 * Build the spawn specification for a source.
 *
 * The launcher's own flags precede the profile in both modes: `dsh` treats the
 * first token it does not recognize as the start of the inner arguments, so
 * `dsh web --patch F` fails with `unknown option '--patch'`.
 *
 * The npx branch also needs a `--` separator before those flags: `npm exec`
 * (what modern `npx` is) otherwise consumes `--profile`/`--patch`/`--no-open`
 * as its own unrecognized CLI config and never forwards them to `dsh`. `pnpm
 * dsh ...` has no such parser in front of it, so the local branch omits it.
 * @param source - configured harness source.
 * @param launchers - resolved pnpm and npx binaries.
 * @param patchFile - absolute path to the cordis patch overlay.
 * @returns command, arguments, and working directory.
 */
export function spawnFor(source: HarnessSource, launchers: Launchers, patchFile: string): SpawnSpec {
  const profileArgs = ['--profile', 'web', '--patch', patchFile, '--no-open']
  if (source.kind === 'local') {
    return { command: launchers.pnpm, args: ['dsh', ...profileArgs], cwd: source.repo }
  }
  return {
    command: launchers.npx,
    args: ['-y', `${source.package}@${source.version}`, '--', ...profileArgs],
    cwd: source.workspace,
  }
}
