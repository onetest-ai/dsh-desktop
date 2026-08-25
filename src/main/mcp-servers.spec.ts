import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dumpDeclaredPatchRow, loadDeclaredPatchRows } from './bundle-patch'
import {
  activeServers,
  mcpErrors,
  MCP_CLIENT_PACKAGE,
  serverEnv,
  serverEnvVar,
  serverRow,
  serverRowId,
  serverRows,
  tokenLabel,
  validServerId,
  validServerUrl,
  type McpConfig,
  type McpServer,
} from './mcp-servers'

/** A configured server with everything valid, overridable per test. */
function server(overrides: Partial<McpServer> = {}): McpServer {
  return { id: 'tavily', preset: 'tavily', url: 'https://mcp.tavily.com/mcp/', enabled: true, ...overrides }
}

/** An `mcp` section carrying the given servers, switched on. */
function config(servers: McpServer[], enabled = true): McpConfig {
  return { enabled, servers }
}

describe('validServerId', () => {
  it('accepts the ids the harness itself accepts as a serverName', () => {
    for (const id of ['tavily', 'GitHub', 'my_server', 'a-b-c', 'x'.repeat(32)]) {
      expect(validServerId(id)).toBe(true)
    }
  })

  it('rejects an id that could not be a tool namespace or a row id', () => {
    for (const id of ['', 'has space', 'has.dot', 'has/slash', 'x'.repeat(33)]) {
      expect(validServerId(id)).toBe(false)
    }
  })
})

describe('validServerUrl', () => {
  it('accepts an https URL', () => {
    expect(validServerUrl('https://mcp.tavily.com/mcp/')).toBe(true)
  })

  it('rejects http, which would put the bearer token on the wire in cleartext', () => {
    expect(validServerUrl('http://mcp.tavily.com/mcp/')).toBe(false)
  })

  it('rejects a non-URL', () => {
    expect(validServerUrl('mcp.tavily.com')).toBe(false)
  })
})

describe('serverEnvVar', () => {
  it('derives an environment variable name from the server id', () => {
    expect(serverEnvVar('tavily')).toBe('DSH_MCP_TOKEN_TAVILY')
  })

  it('turns a hyphen into an underscore, which a shell variable name requires', () => {
    expect(serverEnvVar('my-server')).toBe('DSH_MCP_TOKEN_MY_SERVER')
  })
})

describe('serverRowId', () => {
  it('namespaces the row so it cannot collide with a plugin entry id', () => {
    expect(serverRowId('tavily')).toBe('mcp-tavily')
  })
})

describe('activeServers', () => {
  it('mounts nothing when the section is absent', () => {
    expect(activeServers(undefined)).toEqual([])
  })

  it('mounts nothing when the master switch is off, without losing the servers', () => {
    const mcp = config([server()], false)
    expect(activeServers(mcp)).toEqual([])
    expect(mcp.servers).toHaveLength(1)
  })

  it('mounts only the servers that are themselves enabled', () => {
    const mcp = config([server({ id: 'tavily' }), server({ id: 'github', enabled: false })])
    expect(activeServers(mcp).map((entry) => entry.id)).toEqual(['tavily'])
  })
})

describe('serverRow', () => {
  it('mounts an instance of the MCP client plugin', () => {
    expect(serverRow(server()).name).toBe(MCP_CLIENT_PACKAGE)
  })

  it('names the tool namespace after the server id', () => {
    const config = serverRow(server()).config as Record<string, unknown>
    expect(config.serverName).toBe('tavily')
  })

  it('reaches the server over Streamable HTTP at its configured URL', () => {
    const config = serverRow(server()).config as Record<string, unknown>
    expect(config).toMatchObject({ transport: 'streamable-http', url: 'https://mcp.tavily.com/mcp/' })
  })

  it('names the token through an environment lookup rather than embedding it', () => {
    const yaml = dumpDeclaredPatchRow(serverRow(server()))
    expect(yaml).toContain('!!js')
    expect(yaml).toContain('Bearer ${process.env.DSH_MCP_TOKEN_TAVILY}')
  })

  it('survives the write-and-read-back the harness loader performs on the overlay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-mcp-row-'))
    writeFileSync(join(directory, 'cordis.patch.yml'), `- insert:\n${dumpDeclaredPatchRow(serverRow(server()))}`)
    const rows = loadDeclaredPatchRows(directory, 'cordis.patch.yml')
    expect(rows).toHaveLength(1)
    // Re-dumping proves the `!!js` tag round-tripped as an expression rather
    // than degrading into an ordinary quoted string.
    expect(dumpDeclaredPatchRow(rows![0])).toContain('!!js')
    expect(dumpDeclaredPatchRow(rows![0])).toContain('Bearer ${process.env.DSH_MCP_TOKEN_TAVILY}')
  })

  it('emits the row under its own id, so two servers never collide', () => {
    const first = dumpDeclaredPatchRow(serverRow(server({ id: 'tavily' })))
    const second = dumpDeclaredPatchRow(serverRow(server({ id: 'github' })))
    expect(first).toContain('id: mcp-tavily')
    expect(second).toContain('id: mcp-github')
  })
})

describe('serverRows', () => {
  it('contributes one row per enabled server', () => {
    const rows = serverRows(config([server({ id: 'tavily' }), server({ id: 'github' })]))
    expect(rows.map((row) => row.id)).toEqual(['mcp-tavily', 'mcp-github'])
  })

  it('contributes nothing when MCP is off', () => {
    expect(serverRows(config([server()], false))).toEqual([])
  })
})

describe('serverEnv', () => {
  it('carries each enabled server token under its own variable', () => {
    const env = serverEnv(config([server()]), () => 'tvly-abc')
    expect(env).toEqual({ DSH_MCP_TOKEN_TAVILY: 'tvly-abc' })
  })

  it('passes an empty value for a server with no stored token, never the text "undefined"', () => {
    const env = serverEnv(config([server()]), () => undefined)
    expect(env.DSH_MCP_TOKEN_TAVILY).toBe('')
  })

  it('carries nothing for a disabled server', () => {
    expect(serverEnv(config([server({ enabled: false })]), () => 'tvly-abc')).toEqual({})
  })
})

describe('tokenLabel', () => {
  it("uses the vendor's own name for its credential", () => {
    expect(tokenLabel(server({ preset: 'github' }))).toBe('Personal access token')
  })

  it('falls back to a neutral label for a hand-added server', () => {
    expect(tokenLabel(server({ preset: undefined }))).toBe('Token')
  })

  it('falls back for a preset id that is no longer shipped', () => {
    expect(tokenLabel(server({ preset: 'retired' }))).toBe('Token')
  })
})

describe('mcpErrors', () => {
  it('accepts a valid section', () => {
    expect(mcpErrors(config([server()]))).toEqual([])
  })

  it('rejects an id that cannot be a tool namespace', () => {
    expect(mcpErrors(config([server({ id: 'has space' })]))[0]).toContain('not a valid server name')
  })

  it('rejects the same id twice, which would collide in the overlay', () => {
    expect(mcpErrors(config([server(), server()]))[0]).toContain('listed more than once')
  })

  it('rejects a non-https URL', () => {
    expect(mcpErrors(config([server({ url: 'http://x.example/mcp' })]))[0]).toContain('https://')
  })

  it('checks a disabled server too, so a bad entry cannot be hidden by its switch', () => {
    expect(mcpErrors(config([server({ enabled: false, url: 'nope' })]))).toHaveLength(1)
  })
})
