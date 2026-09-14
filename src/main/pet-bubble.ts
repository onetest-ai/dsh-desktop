/**
 * Turns a harness hook event into a pet animation state and a short speech-
 * bubble line — mirroring Petdex's bubble-templates.
 *
 * The bubble text is always *templated* here from tool metadata (a tool
 * name, a file path, a shell command's first word, a search pattern) —
 * never the model's actual output or a prompt's raw text. The harness hook
 * that calls `describe` only ever hands it `tool_name`/`tool_input`, which
 * keeps this a privacy boundary as much as a UI one: nothing the model
 * said or generated can end up floating over the desktop pet, on-screen for
 * anyone glancing at the machine, or logged anywhere along that path.
 */

/** The harness hook events the pet's hook script can report. */
export type PetEvent = 'prompt' | 'tool' | 'tool-done' | 'notify' | 'stop' | 'error'

/**
 * The pet's animation states. A superset of v1's (`idle`/`running`/
 * `waiting`/`wave`) — the spellings of those four are kept identical so v1
 * callers and saved state stay valid; `jumping`/`failed`/`review` are new.
 */
export type PetDriveState = 'idle' | 'running' | 'waiting' | 'wave' | 'jumping' | 'failed' | 'review'

/** The shape a `PreToolUse`/`PostToolUse` hook payload carries — both fields optional and untrusted. */
export interface HookInput {
  tool_name?: string
  tool_input?: Record<string, unknown>
}

const MAX_TEXT_LENGTH = 40

/** Truncates to `MAX_TEXT_LENGTH`, replacing the tail with an ellipsis so the result never exceeds it. */
function truncate(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text
  return `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`
}

/** Reads a string field off `tool_input`, tolerating a missing/non-object `tool_input` or a non-string value. */
function stringField(input: HookInput | undefined, field: string): string | undefined {
  const toolInput = input?.tool_input
  if (!toolInput || typeof toolInput !== 'object') return undefined
  const value = (toolInput as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

/** Last path segment, tolerating both `/` and `\` separators; falls back to the whole string. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** The first whitespace-delimited token of a shell command. */
function firstWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? command
}

/** `new URL(url).hostname`, falling back to the raw string when it doesn't parse. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Builds the `tool`/`tool-done` bubble phrase from a (possibly incomplete) hook payload. */
function toolPhrase(input?: HookInput): string {
  const name = input?.tool_name
  if (!name) return 'Calling tool'
  const lower = name.toLowerCase()

  switch (lower) {
    case 'read': {
      const filePath = stringField(input, 'file_path')
      return filePath ? `Reading ${basename(filePath)}` : `Calling ${name}`
    }
    case 'edit':
    case 'write': {
      const filePath = stringField(input, 'file_path')
      return filePath ? `Editing ${basename(filePath)}` : `Calling ${name}`
    }
    case 'bash': {
      const command = stringField(input, 'command')
      return command ? `Running ${firstWord(command)}` : `Calling ${name}`
    }
    case 'grep': {
      const pattern = stringField(input, 'pattern')
      return pattern ? `Searching "${pattern}"` : `Calling ${name}`
    }
    case 'glob': {
      const pattern = stringField(input, 'pattern')
      return pattern ? `Listing ${pattern}` : `Calling ${name}`
    }
    case 'webfetch': {
      const url = stringField(input, 'url')
      return url ? `Fetching ${hostname(url)}` : `Calling ${name}`
    }
    case 'task':
    case 'subagent': {
      const description = stringField(input, 'description')
      return `Spawning ${description ?? 'subagent'}`
    }
    default:
      return `Calling ${name}`
  }
}

/**
 * Maps one hook event to `{ state, text }` for the pet to display. Never
 * throws — every field access is guarded, and an absent/malformed
 * `tool_input` just falls back to the generic "Calling <tool>" phrase.
 */
export function describe(event: PetEvent, input?: HookInput): { state: PetDriveState; text: string } {
  switch (event) {
    case 'prompt':
      return { state: 'jumping', text: truncate('Thinking…') }
    case 'notify':
      return { state: 'waiting', text: truncate('Waiting for you…') }
    case 'stop':
      return { state: 'wave', text: truncate('Done.') }
    case 'error':
      return { state: 'failed', text: truncate(`${input?.tool_name ?? 'Tool'} failed`) }
    case 'tool':
    case 'tool-done':
      return { state: 'running', text: truncate(toolPhrase(input)) }
    default:
      return { state: 'idle', text: '' }
  }
}
