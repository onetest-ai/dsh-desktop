import { describe as suite, it, expect } from 'vitest'
import { describe } from './pet-bubble'

suite('pet-bubble describe', () => {
  it('prompt → jumping, Thinking…', () => {
    expect(describe('prompt')).toEqual({ state: 'jumping', text: 'Thinking…' })
  })

  it('notify → waiting, Waiting for you…', () => {
    expect(describe('notify')).toEqual({ state: 'waiting', text: 'Waiting for you…' })
  })

  it('stop → wave, Done.', () => {
    expect(describe('stop')).toEqual({ state: 'wave', text: 'Done.' })
  })

  it('error uses tool_name when present', () => {
    expect(describe('error', { tool_name: 'Read' })).toEqual({ state: 'failed', text: 'Read failed' })
  })

  it('error falls back to Tool when tool_name missing', () => {
    expect(describe('error')).toEqual({ state: 'failed', text: 'Tool failed' })
  })

  it('tool Read → Reading <basename>', () => {
    expect(describe('tool', { tool_name: 'Read', tool_input: { file_path: '/a/auth.ts' } })).toEqual({
      state: 'running',
      text: 'Reading auth.ts',
    })
  })

  it('tool Edit → Editing <basename>', () => {
    expect(describe('tool', { tool_name: 'Edit', tool_input: { file_path: '/a/b/main.ts' } })).toEqual({
      state: 'running',
      text: 'Editing main.ts',
    })
  })

  it('tool Write → Editing <basename>', () => {
    expect(describe('tool', { tool_name: 'Write', tool_input: { file_path: '/a/b/notes.md' } })).toEqual({
      state: 'running',
      text: 'Editing notes.md',
    })
  })

  it('tool Bash → Running <first word>', () => {
    expect(describe('tool', { tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } })).toEqual({
      state: 'running',
      text: 'Running npm',
    })
  })

  it('tool Grep → Searching "<pattern>"', () => {
    expect(describe('tool', { tool_name: 'Grep', tool_input: { pattern: 'foo' } })).toEqual({
      state: 'running',
      text: 'Searching "foo"',
    })
  })

  it('tool Glob → Listing <pattern>', () => {
    expect(describe('tool', { tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } })).toEqual({
      state: 'running',
      text: 'Listing **/*.ts',
    })
  })

  it('tool WebFetch → Fetching <hostname>', () => {
    expect(
      describe('tool', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/path?x=1' } }),
    ).toEqual({ state: 'running', text: 'Fetching example.com' })
  })

  it('tool WebFetch with an unparseable url falls back to the raw string', () => {
    expect(describe('tool', { tool_name: 'WebFetch', tool_input: { url: 'not a url' } })).toEqual({
      state: 'running',
      text: 'Fetching not a url',
    })
  })

  it('tool Task → Spawning <description>', () => {
    expect(describe('tool', { tool_name: 'Task', tool_input: { description: 'refactor bubbles' } })).toEqual({
      state: 'running',
      text: 'Spawning refactor bubbles',
    })
  })

  it('tool Subagent with no description → Spawning subagent', () => {
    expect(describe('tool', { tool_name: 'Subagent', tool_input: {} })).toEqual({
      state: 'running',
      text: 'Spawning subagent',
    })
  })

  it('tool with case-insensitive name still matches', () => {
    expect(describe('tool', { tool_name: 'read', tool_input: { file_path: '/x/y.ts' } })).toEqual({
      state: 'running',
      text: 'Reading y.ts',
    })
  })

  it('unknown tool name → Calling <tool_name>', () => {
    expect(describe('tool', { tool_name: 'Xyz' })).toEqual({ state: 'running', text: 'Calling Xyz' })
  })

  it('missing tool_name entirely → Calling tool', () => {
    expect(describe('tool')).toEqual({ state: 'running', text: 'Calling tool' })
  })

  it('tool-done keeps state running and reuses the tool phrase', () => {
    expect(describe('tool-done', { tool_name: 'Read', tool_input: { file_path: '/a/auth.ts' } })).toEqual({
      state: 'running',
      text: 'Reading auth.ts',
    })
  })

  it('never throws when tool_input is missing entirely', () => {
    expect(() => describe('tool', { tool_name: 'Bash' })).not.toThrow()
    expect(describe('tool', { tool_name: 'Bash' })).toEqual({ state: 'running', text: 'Calling Bash' })
  })

  it('never throws when tool_input is not an object', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => describe('tool', { tool_name: 'Read', tool_input: 'nope' as any })).not.toThrow()
  })

  it('never throws with no input at all', () => {
    expect(() => describe('tool')).not.toThrow()
    expect(() => describe('error')).not.toThrow()
  })

  it('truncates text over 40 chars with an ellipsis', () => {
    const { text } = describe('tool', {
      tool_name: 'Bash',
      tool_input: { command: 'a'.repeat(60) },
    })
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text.endsWith('…')).toBe(true)
  })

  it('truncates a long file path phrase', () => {
    const { text } = describe('tool', {
      tool_name: 'Read',
      tool_input: { file_path: '/x/' + 'y'.repeat(60) + '.ts' },
    })
    expect(text.length).toBeLessThanOrEqual(40)
  })
})
