import { firstLine, type ActionOutcome } from './git-actions'
import { runGit } from './git-run'

/** Which of the failures the panel knows how to talk about this was. */
export type TroubleKind = 'https' | 'publickey' | 'hostkey' | 'rejected' | 'no-upstream'

/** A failure the panel recognises, and the sentence it says instead. */
export interface Trouble {
  kind: TroubleKind
  /** One line, in the panel's own voice; never git's wrapping and advice. */
  say: string
}

/**
 * The failures worth translating, in the order they are looked for.
 *
 * Ordered because more than one can match: a push to a branch with no
 * upstream over a remote whose credential is also missing says both, and the
 * upstream is the one with a button on it. Matched case-insensitively on a
 * fragment rather than a whole line — git wraps, capitalises and phrases
 * these differently across versions, and a table matching whole lines would
 * go quiet after an upgrade with nothing to say it had.
 */
const KNOWN: { has: string; kind: TroubleKind; say: string }[] = [
  {
    has: 'no upstream',
    kind: 'no-upstream',
    say: 'This branch has no upstream yet, so git does not know where to push it.',
  },
  {
    has: 'could not read username',
    kind: 'https',
    say: 'This remote needs an HTTPS credential this app does not have.',
  },
  {
    has: 'permission denied (publickey',
    kind: 'publickey',
    say: 'The SSH key for this remote is not loaded in your agent.',
  },
  {
    has: 'host key verification failed',
    kind: 'hostkey',
    say: 'This host is not in your known_hosts yet.',
  },
  {
    has: 'authentication failed',
    kind: 'rejected',
    say: 'The stored credential for this remote was rejected.',
  },
]

/**
 * Recognise a remote failure the panel can say something useful about.
 *
 * This app deliberately supplies no askpass of its own — a credential it
 * never sees is one it cannot leak — so the cost is stated rather than
 * hidden: a repository whose credential is not already cached cannot push
 * from the panel. That cost is only acceptable if the panel says which of
 * these it hit and offers the terminal, so it is worth recognising them
 * exactly and saying nothing about the rest.
 *
 * A failure that is not here comes through as git's own first line, which is
 * the right answer for a non-fast-forward or a hook: those are ordinary
 * refusals with nothing this panel can add.
 * @param text - what git wrote, normally stderr.
 * @returns which failure it was and what to say, or nothing when it is not one of these.
 */
export function remoteTrouble(text: string): Trouble | undefined {
  // A `remote:` line is the server's own words, echoed verbatim rather than
  // written by the git this app is running — a pre-receive hook's own
  // "Authentication failed" is about a token this machine never held, and
  // matching it here would send the user to Open in Terminal for a remedy
  // that has nothing to do with this machine.
  const said = text
    .split('\n')
    .filter((line) => !/^\s*remote:/i.test(line))
    .join('\n')
    .toLowerCase()
  const found = KNOWN.find((one) => said.includes(one.has))
  return found === undefined ? undefined : { kind: found.kind, say: found.say }
}

/**
 * The lines of a stream, trimmed, with the blank ones dropped.
 *
 * A local copy rather than a shared one: `firstLine`'s own `spoken` is not
 * exported, and it should not be — its rule is right only for the local git
 * commands that lead with `fatal:`, and giving `remoteLine` a shared helper
 * invites someone to reach for `firstLine` here again later.
 * @param text - a whole stream.
 * @returns the lines worth reading, in order.
 */
function spoken(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** A ref-status line `git push`/`git pull` prints under their `To `/`From ` narration. */
const REF_STATUS = /^(\*\s|[0-9a-f]{4,40}\.\.[0-9a-f]{4,40}\s)/

/**
 * What `git push` or `git pull` said, cut to the line that names the problem.
 *
 * `firstLine` takes stderr's first line, which is right for a local command
 * that leads with `fatal:` — but a remote one narrates first: a `To <url>` or
 * `From <url>` line, then the ref-status lines that follow it, and only after
 * that does it say what went wrong. Taking the first line there reports the
 * narration — a URL that reads like success — for the two commonest failures
 * of the two commonest operations: a non-fast-forward push, and a divergent
 * pull with no `pull.rebase` configured.
 *
 * The narration is skipped, then the remainder is searched in the order a
 * problem is most plainly named: `error:`/`fatal:` first, a rejected ref
 * line next, a `hint:` only when nothing more direct is there.
 * @param stderr - what git wrote to stderr.
 * @param stdout - what it wrote to stdout, read only when stderr is silent.
 * @returns the line to show.
 */
export function remoteLine(stderr: string, stdout: string): string {
  const said = spoken(stderr)
  if (said.length === 0) return firstLine(stderr, stdout)
  let start = /^(To|From)\s/.test(said[0]) ? 1 : 0
  while (start < said.length && REF_STATUS.test(said[start])) start++
  const rest = said.slice(start)
  const pick = (test: (line: string) => boolean): string | undefined => rest.find(test)
  const found =
    pick((line) => /^error:/i.test(line)) ??
    pick((line) => /^fatal:/i.test(line)) ??
    pick((line) => line.startsWith('! [')) ??
    pick((line) => /^hint:/i.test(line))
  return found ?? rest[0] ?? said[0]
}

/** The four things the panel asks a remote for. */
export type RemoteOp = 'fetch' | 'pull' | 'push' | 'publish'

/** What one remote operation reported, with the trouble when it was one. */
export type RemoteOutcome = ActionOutcome & { trouble?: TroubleKind }

/**
 * How long a remote operation may take.
 *
 * Four times the local timeout. A first fetch on a large repository over a
 * domestic link runs past thirty seconds routinely, and being cut off there
 * is indistinguishable to the user from the network being broken. It is still
 * bounded, and Cancel is the answer for an operation going nowhere.
 */
export const REMOTE_TIMEOUT_MS = 120_000

/** What the panel says instead of git's silence when the user stopped it. */
const CANCELLED = 'Cancelled.'

/**
 * The remote a branch would be published to, when there is exactly one.
 *
 * Read from `git remote` rather than taken from the caller: the name reaches
 * a command line, and the only names that do so here are ones git itself
 * produced. Several remotes is a refusal rather than a guess — publishing to
 * a fork nobody was watching is not a mistake the panel should be able to
 * make on the user's behalf.
 * @param repo - the repository.
 * @param signal - kills the child.
 * @param run - how to run git.
 * @returns the remote's name, or why there is not exactly one.
 */
async function onlyRemote(
  repo: string,
  signal: AbortSignal | undefined,
  run: typeof runGit,
): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  const out = await run(repo, ['remote'], 'git', { timeoutMs: REMOTE_TIMEOUT_MS, signal })
  if (out.code !== 0) return { ok: false, reason: firstLine(out.stderr, out.stdout.toString('utf8')) }
  const names = out.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (names.length === 0) return { ok: false, reason: 'This repository has no remote to publish to.' }
  if (names.length > 1) {
    return { ok: false, reason: 'This repository has more than one remote, so push it once from the terminal.' }
  }
  return { ok: true, name: names[0] }
}

/**
 * The arguments for one operation.
 *
 * `publish` is absent because it needs a remote read first; see `remote`.
 * @param op - which operation.
 * @returns the arguments, without the program name.
 */
function argsFor(op: Exclude<RemoteOp, 'publish'>): string[] {
  // Plain, every one of them. `pull` without `--rebase` or `--no-rebase`
  // respects the user's own pull.rebase; `push` without `--force` is the only
  // push this panel makes, behind no modifier, at no point.
  return [op]
}

/**
 * Ask a remote for one thing.
 *
 * One command each, never a combined Sync: sync is pull-then-push, and a
 * compound operation that half-succeeded is one the panel then has to
 * explain — usually while the user is looking at a repository in a state
 * neither half described.
 *
 * A failure the panel recognises is said in the panel's own words with its
 * kind attached, so a note can hang a button on it; everything else comes
 * through as git's own first line, which is the right answer for a
 * non-fast-forward or a hook.
 * @param repo - the repository.
 * @param op - which operation.
 * @param signal - kills the child; an aborted one is reported as a cancel rather than as git's silence.
 * @param run - how to run git; injected so tests spawn nothing.
 * @returns success, or why not and which trouble it was.
 */
export async function remote(
  repo: string,
  op: RemoteOp,
  signal?: AbortSignal,
  run: typeof runGit = runGit,
): Promise<RemoteOutcome> {
  let args: string[]
  if (op === 'publish') {
    const found = await onlyRemote(repo, signal, run)
    if (!found.ok) return signal?.aborted === true ? { ok: false, reason: CANCELLED } : found
    args = ['push', '--set-upstream', found.name, 'HEAD']
  } else {
    args = argsFor(op)
  }
  const out = await run(repo, args, 'git', { timeoutMs: REMOTE_TIMEOUT_MS, signal })
  if (out.code === 0) return { ok: true }
  // Before anything is read off the streams: a killed child usually wrote
  // nothing to either, and `firstLine` would report that as "git failed
  // without saying why" — a fault, rather than the thing just asked for.
  if (signal?.aborted === true) return { ok: false, reason: CANCELLED }
  const said = out.stderr === '' ? out.stdout.toString('utf8') : out.stderr
  const trouble = remoteTrouble(said)
  if (trouble !== undefined) return { ok: false, reason: trouble.say, trouble: trouble.kind }
  return { ok: false, reason: remoteLine(out.stderr, out.stdout.toString('utf8')) }
}
