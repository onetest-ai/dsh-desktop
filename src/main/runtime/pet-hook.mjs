#!/usr/bin/env node
// Written into the harness runtime dir at boot and invoked by every hooksConfig
// command as `node pet-hook.mjs <port> <event>` — see src/main/runtime-files.ts.
// It runs under the HARNESS's node, standalone, with no access to our `dist` or
// node_modules, so it is deliberately dependency-free (Node stdlib only) and
// fails silently end to end: a broken hook must never block the harness turn.
//
// `describe` below is a hand-kept copy of src/main/pet-bubble.ts's templater —
// this duplication is intentional (see CLAUDE.md's cross-boundary convention);
// keep the two in sync by hand when the bubble vocabulary changes.

import http from 'node:http'

const MAX_TEXT_LENGTH = 40
const MAX_STDIN_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 300
/** Upper bound on waiting for stdin to close; a hook host that never sends
 * EOF must not hang this script forever — resolve with whatever arrived. */
const STDIN_TIMEOUT_MS = 1000

/** Truncates to MAX_TEXT_LENGTH, replacing the tail with an ellipsis so the result never exceeds it. */
function truncate(text) {
  if (text.length <= MAX_TEXT_LENGTH) return text
  return `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`
}

/** Reads a string field off `tool_input`, tolerating a missing/non-object `tool_input` or a non-string value. */
function stringField(input, field) {
  const toolInput = input && input.tool_input
  if (!toolInput || typeof toolInput !== 'object') return undefined
  const value = toolInput[field]
  return typeof value === 'string' ? value : undefined
}

/** Last path segment, tolerating both `/` and `\` separators; falls back to the whole string. */
function basename(path) {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** The first whitespace-delimited token of a shell command. */
function firstWord(command) {
  return command.trim().split(/\s+/)[0] ?? command
}

/** `new URL(url).hostname`, falling back to the raw string when it doesn't parse. */
function hostname(url) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Builds the `tool`/`tool-done` bubble phrase from a (possibly incomplete) hook payload. */
function toolPhrase(input) {
  const name = input && input.tool_name
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
export function describe(event, input) {
  switch (event) {
    case 'prompt':
      return { state: 'jumping', text: truncate('Thinking…') }
    case 'notify':
      return { state: 'waiting', text: truncate('Waiting for you…') }
    case 'stop':
      return { state: 'wave', text: truncate('Done.') }
    case 'error':
      return { state: 'failed', text: truncate(`${(input && input.tool_name) ?? 'Tool'} failed`) }
    case 'tool':
    case 'tool-done':
      return { state: 'running', text: truncate(toolPhrase(input)) }
    default:
      return { state: 'idle', text: '' }
  }
}

/**
 * Turns a hook's parsed stdin JSON into the `/pet/event` POST body for
 * `event`. `json` is untrusted and may be `{}` (parse failure) or missing
 * fields entirely — `describe` tolerates both.
 */
export function buildBody(event, json) {
  const input = json && typeof json === 'object' ? { tool_name: json.tool_name, tool_input: json.tool_input } : undefined
  return describe(event, input)
}

/**
 * Reads stdin to a `MAX_STDIN_BYTES`-capped Buffer; excess bytes are read and
 * discarded, never buffered. Self-sufficient even if stdin never closes — a
 * host that keeps the pipe open (or never writes anything) would otherwise
 * hang this script forever, and it must always exit 0 quickly.
 */
function readStdinCapped() {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    }
    process.stdin.on('data', (chunk) => {
      if (total < MAX_STDIN_BYTES) {
        const room = MAX_STDIN_BYTES - total
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
      }
      total += chunk.length
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS)
    timer.unref?.()
  })
}

/** Fire-and-forget POST of `body` to `http://127.0.0.1:<port>/pet/event`; every failure mode is swallowed. */
function postEvent(port, body) {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    try {
      const payload = JSON.stringify(body)
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/pet/event',
          method: 'POST',
          timeout: REQUEST_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          res.resume()
          res.on('end', done)
        },
      )
      req.on('timeout', () => {
        req.destroy()
        done()
      })
      req.on('error', done)
      req.write(payload)
      req.end()
    } catch {
      done()
    }
  })
}

async function main() {
  const port = Number(process.argv[2])
  const event = process.argv[3]

  let json = {}
  try {
    const raw = await readStdinCapped()
    json = JSON.parse(raw.toString('utf8'))
  } catch {
    json = {}
  }

  const body = buildBody(event, json)

  if (Number.isFinite(port)) {
    await postEvent(port, body)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0))
}
