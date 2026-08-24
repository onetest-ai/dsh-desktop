import { describe, expect, it } from 'vitest'
import { isConfigurationProblem, summarizeFailure } from './error-summary'

/**
 * The raw `disabledReason` text a real boot failure produced for
 * `@deepseek-ai/dsh-mcp-client` (abridged by the harness's own dedupe of
 * repeated stack frames, not by this test) — copied verbatim, including the
 * message repeating once per `cause` level and the literal `... N lines
 * matching cause stack trace ...` marker Node emits. The UI's own "Disabled
 * — the harness would not start with it: " prefix (added by
 * `settings.js`, not part of the stored reason) is not included here.
 */
const REAL_MCP_CLIENT_REASON = `dsh-desktop: the harness exited with code 1
before starting. Users/arozumenko/.dsh/runtimes/QGRlZXBzZWVrLWFpL2RzaA/.../cordis-plugin-loader/lib/index.js:299:9)
at Entry._init (file:///...) at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
{ [cause]: Error: failed to apply loader entry deepseek-ai-dsh-mcp-client (/home/dev/.dsh/plugins/deepseek-ai-dsh-mcp-client/lib/index.js):
invalid config: - expected { transport?: "stdio", serverName: string, command: string, args?: string[],
env?: ..., failOnStartupError?: boolean } | { transport?: "streamable-http", serverName: string,
url: string, ... } but got {} at updateError (file:///...) at Entry._init (file:///...)
... 2 lines matching cause stack trace ... at async Promise.allSettled (index 135) ...
{ [cause]: ValidationError: invalid config: - expected {...} but got {} at resolveConfig (file:///...) ...`

describe('summarizeFailure', () => {
  it('extracts the one meaningful sentence from a real nested cause chain, dropping frames and duplication', () => {
    const summary = summarizeFailure(REAL_MCP_CLIENT_REASON)

    expect(summary).toContain('expected')
    expect(summary).toContain('but got {}')
    expect(summary).not.toContain('at Entry._init')
    expect(summary).not.toContain('file:///')
    expect(summary).not.toContain('lines matching cause stack trace')
  })

  it('falls back to a bounded prefix when nothing recognizable as a message line survives', () => {
    const unstructured = Array.from({ length: 50 }, (_, i) => `    at frame${String(i)} (file:///x/y/z.js:${String(i)}:1)`).join('\n')

    const summary = summarizeFailure(unstructured)

    expect(summary.length).toBeGreaterThan(0)
    expect(summary.length).toBeLessThanOrEqual(400)
  })

  it('never returns an empty reason, even for blank input', () => {
    expect(summarizeFailure('').length).toBeGreaterThan(0)
    expect(summarizeFailure('   \n  \n').length).toBeGreaterThan(0)
  })

  it('bounds a long single-line message rather than reproducing it in full', () => {
    const long = `x is not resolvable from /some/dir: ${'a'.repeat(500)}`

    const summary = summarizeFailure(long)

    expect(summary.length).toBeLessThanOrEqual(400)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('passes through a short, single-line resolver message unchanged (the unresolvable-library case)', () => {
    const reason = '@modelcontextprotocol/sdk is not resolvable from /home/x/.dsh/plugins/x: Cannot find module'

    expect(summarizeFailure(reason)).toBe(reason)
  })
})

describe('isConfigurationProblem', () => {
  it('classifies the real dsh-mcp-client config-validation failure as a configuration problem', () => {
    expect(isConfigurationProblem(REAL_MCP_CLIENT_REASON)).toBe(true)
  })

  it('keeps the expected-shape text in what summarizeFailure extracts from that same reason, so the setup fix stays legible', () => {
    const summary = summarizeFailure(REAL_MCP_CLIENT_REASON)

    expect(summary).toContain('transport?: "stdio"')
    expect(summary).toContain('serverName: string')
  })

  it('does not classify a module-resolution failure as a configuration problem', () => {
    const reason = '@modelcontextprotocol/sdk is not resolvable from /home/x/.dsh/plugins/x: Cannot find module'

    expect(isConfigurationProblem(reason)).toBe(false)
  })

  it('does not classify an unfamiliar error shape as a configuration problem, falling back to the failure presentation', () => {
    const reason = 'TypeError: cannot read properties of undefined (reading \'foo\') at Entry._init (file:///plugin/lib/index.js:12:3)'

    expect(isConfigurationProblem(reason)).toBe(false)
  })
})
