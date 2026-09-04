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
  const said = text.toLowerCase()
  const found = KNOWN.find((one) => said.includes(one.has))
  return found === undefined ? undefined : { kind: found.kind, say: found.say }
}
