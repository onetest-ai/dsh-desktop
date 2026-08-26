import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpConfigPath, parseMcpBlock, readMcpConfig, writeMcpConfig, type McpServerEntry } from './mcp-config'

/** A fresh mcp.json path that does not exist yet. */
function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-mcpjson-')), 'mcp.json')
}

/** Write raw text to a fresh mcp.json and return its path. */
function fileWith(text: string): string {
  const file = freshFile()
  writeFileSync(file, text)
  return file
}

/** A minimal valid stdio entry, overridable per test. */
function entry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return { name: 'a', disabled: false, transport: 'stdio', command: 'node', args: [], env: {}, headers: {}, rest: {}, ...overrides }
}

describe('mcpConfigPath', () => {
  it('sits beside desktop.json under the harness home', () => {
    expect(mcpConfigPath('/home/.dsh')).toBe('/home/.dsh/mcp.json')
  })
})

describe('readMcpConfig', () => {
  it('reads a stdio server in the format every README publishes', () => {
    const file = fileWith(JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    }))
    expect(readMcpConfig(file)).toEqual([
      expect.objectContaining({ name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }),
    ])
  })

  it('reads an http server', () => {
    const file = fileWith(JSON.stringify({
      mcpServers: { tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/', headers: { Authorization: 'Bearer x' } } },
    }))
    expect(readMcpConfig(file)).toEqual([
      expect.objectContaining({ name: 'tavily', transport: 'http', url: 'https://mcp.tavily.com/mcp/', headers: { Authorization: 'Bearer x' } }),
    ])
  })

  it('infers stdio from command and http from url, since type is often omitted', () => {
    const file = fileWith(JSON.stringify({ mcpServers: { a: { command: 'node' }, b: { url: 'https://x.example/mcp' } } }))
    expect(readMcpConfig(file).map((s) => s.transport)).toEqual(['stdio', 'http'])
  })

  it('treats a server as enabled unless it says disabled', () => {
    const file = fileWith(JSON.stringify({ mcpServers: { a: { command: 'node' }, b: { command: 'node', disabled: true } } }))
    expect(readMcpConfig(file).map((s) => s.disabled)).toEqual([false, true])
  })

  it('preserves keys it does not model, so a foreign block survives editing', () => {
    const file = fileWith(JSON.stringify({ mcpServers: { a: { command: 'node', autoApprove: ['x'], timeout: 60 } } }))
    expect(readMcpConfig(file)[0].rest).toEqual({ autoApprove: ['x'], timeout: 60 })
  })

  it('reads a missing file as no servers, which is a first run', () => {
    expect(readMcpConfig(freshFile())).toEqual([])
  })

  it('reads a malformed file as no servers rather than throwing', () => {
    expect(readMcpConfig(fileWith('not json'))).toEqual([])
  })

  it('skips an entry with neither command nor url instead of failing the rest', () => {
    const file = fileWith(JSON.stringify({ mcpServers: { good: { command: 'node' }, bad: { note: 'x' } } }))
    expect(readMcpConfig(file).map((s) => s.name)).toEqual(['good'])
  })
})

describe('writeMcpConfig', () => {
  it('round-trips a server', () => {
    const file = freshFile()
    writeMcpConfig(file, readMcpConfig(fileWith(JSON.stringify({ mcpServers: { a: { command: 'node', args: ['x'] } } }))))
    expect(readMcpConfig(file)[0]).toEqual(expect.objectContaining({ command: 'node', args: ['x'] }))
  })

  it('writes owner-only, because entries carry credentials in the clear', () => {
    const file = freshFile()
    writeMcpConfig(file, [entry()])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('emits the mcpServers wrapper other clients expect', () => {
    const file = freshFile()
    writeMcpConfig(file, [entry()])
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['mcpServers'])
  })

  it('omits empty optional keys, so the file stays close to what a user pasted', () => {
    const file = freshFile()
    writeMcpConfig(file, [entry()])
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.a).toEqual({ command: 'node' })
  })

  it('round-trips keys it does not model', () => {
    const file = freshFile()
    writeMcpConfig(file, [entry({ rest: { autoApprove: ['x'] } })])
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.a.autoApprove).toEqual(['x'])
  })

  it('marks a disabled server so other clients read it the same way', () => {
    const file = freshFile()
    writeMcpConfig(file, [entry({ disabled: true })])
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.a.disabled).toBe(true)
  })
})

describe('parseMcpBlock', () => {
  it('accepts a whole block, which is what a README gives you', () => {
    const result = parseMcpBlock(JSON.stringify({ mcpServers: { a: { command: 'node' }, b: { url: 'https://x.example/mcp' } } }))
    expect(result.ok && result.servers.map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('accepts a bare entry map without the wrapper, which people also paste', () => {
    const result = parseMcpBlock(JSON.stringify({ a: { command: 'node' } }))
    expect(result.ok && result.servers.map((s) => s.name)).toEqual(['a'])
  })

  it('rejects text that is not JSON, naming the problem', () => {
    const result = parseMcpBlock('{ not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/JSON/i)
  })

  it('rejects a block with no usable server', () => {
    expect(parseMcpBlock(JSON.stringify({ mcpServers: {} })).ok).toBe(false)
  })
})
