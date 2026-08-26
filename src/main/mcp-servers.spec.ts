import { describe, expect, it } from 'vitest'
import { dumpDeclaredPatchRow } from './bundle-patch'
import type { McpServerEntry } from './mcp-config'
import {
  activeServers,
  MCP_CLIENT_PACKAGE,
  mcpErrors,
  serverEnv,
  serverRowId,
  serverRows,
  validServerName,
  validServerUrl,
  valueEnvVar,
} from './mcp-servers'

/** A configured stdio entry, overridable per test. */
function stdio(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: 'playwright',
    disabled: false,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: { API_KEY: 'sk-secret' },
    cwd: '/w',
    headers: {},
    rest: {},
    ...overrides,
  }
}

/** A configured http entry, overridable per test. */
function http(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: 'tavily',
    disabled: false,
    transport: 'http',
    args: [],
    env: {},
    url: 'https://mcp.tavily.com/mcp/',
    headers: { Authorization: 'Bearer tvly-secret' },
    rest: {},
    ...overrides,
  }
}

describe('validServerName', () => {
  it('accepts the names the harness itself accepts as a serverName', () => {
    for (const name of ['tavily', 'GitHub', 'my_server', 'a-b-c', 'x'.repeat(32)]) {
      expect(validServerName(name)).toBe(true)
    }
  })

  it('rejects a name that could not be a tool namespace or a row id', () => {
    for (const name of ['', 'has space', 'has.dot', 'has/slash', 'x'.repeat(33)]) {
      expect(validServerName(name)).toBe(false)
    }
  })
})

describe('validServerUrl', () => {
  it('accepts https', () => {
    expect(validServerUrl('https://mcp.tavily.com/mcp/')).toBe(true)
  })

  it('rejects http, which would put a bearer token on the wire in cleartext', () => {
    expect(validServerUrl('http://mcp.tavily.com/mcp/')).toBe(false)
  })
})

describe('serverRowId', () => {
  it('namespaces the row so it cannot collide with a plugin entry id', () => {
    expect(serverRowId('tavily')).toBe('mcp-tavily')
  })
})

describe('valueEnvVar', () => {
  it('leads with the index, so two servers cannot collide on a sanitized name', () => {
    // Server `a-b` key `c` and server `a` key `b-c` both sanitize to A_B_C;
    // the index is what keeps one from overwriting the other's credential.
    expect(valueEnvVar(0, 'API_KEY')).not.toBe(valueEnvVar(1, 'API_KEY'))
  })

  it('keeps the key recognizable for debugging', () => {
    expect(valueEnvVar(0, 'API_KEY')).toBe('DSH_MCP_0_API_KEY')
  })

  it('sanitizes a key that is not a legal variable name', () => {
    expect(valueEnvVar(0, 'X-Api-Key')).toBe('DSH_MCP_0_X_API_KEY')
  })
})

describe('activeServers', () => {
  it('mounts nothing when the master switch is off, without losing the servers', () => {
    const servers = [stdio()]
    expect(activeServers(servers, false)).toEqual([])
    expect(servers).toHaveLength(1)
  })

  it('mounts only the servers that are not disabled', () => {
    expect(activeServers([stdio(), http({ disabled: true })], true).map((s) => s.name)).toEqual(['playwright'])
  })
})

describe('stdio rows', () => {
  it('mounts an mcp-client instance over stdio', () => {
    const config = serverRows([stdio()], true)[0].config as Record<string, unknown>
    expect(config).toMatchObject({ transport: 'stdio', serverName: 'playwright', command: 'npx', cwd: '/w' })
  })

  it('passes the command arguments through unchanged', () => {
    const config = serverRows([stdio()], true)[0].config as Record<string, unknown>
    expect(config.args).toEqual(['-y', '@playwright/mcp@latest'])
  })

  it('never writes an env value into the overlay, which is world-readable', () => {
    const yaml = dumpDeclaredPatchRow(serverRows([stdio()], true)[0])
    expect(yaml).not.toContain('sk-secret')
    expect(yaml).toContain('!!js')
  })

  it('carries every env value to the child by environment instead', () => {
    expect(Object.values(serverEnv([stdio()], true))).toContain('sk-secret')
  })

  it('gives two servers sharing an env key distinct variables, so neither is overwritten', () => {
    const env = serverEnv([stdio(), stdio({ name: 'other', env: { API_KEY: 'other-secret' } })], true)
    expect(Object.keys(env)).toHaveLength(2)
    expect(new Set(Object.values(env))).toEqual(new Set(['sk-secret', 'other-secret']))
  })

  it('names in the row exactly the variables serverEnv defines', () => {
    const servers = [stdio(), stdio({ name: 'other', env: { API_KEY: 'other-secret' } })]
    const yaml = serverRows(servers, true).map(dumpDeclaredPatchRow).join('')
    for (const variable of Object.keys(serverEnv(servers, true))) expect(yaml).toContain(variable)
  })
})

describe('http rows', () => {
  it('mounts an mcp-client instance over streamable http', () => {
    const config = serverRows([http()], true)[0].config as Record<string, unknown>
    expect(config).toMatchObject({ transport: 'streamable-http', serverName: 'tavily', url: 'https://mcp.tavily.com/mcp/' })
  })

  it('never writes a header value into the overlay', () => {
    const yaml = dumpDeclaredPatchRow(serverRows([http()], true)[0])
    expect(yaml).not.toContain('tvly-secret')
    expect(yaml).toContain('!!js')
  })

  it('carries the header value by environment', () => {
    expect(Object.values(serverEnv([http()], true))).toContain('Bearer tvly-secret')
  })

  it('names the package the harness mounts', () => {
    expect(serverRows([http()], true)[0].name).toBe(MCP_CLIENT_PACKAGE)
  })
})

describe('mcpErrors', () => {
  it('accepts valid servers', () => {
    expect(mcpErrors([stdio(), http()])).toEqual([])
  })

  it('rejects a stdio server with no command', () => {
    expect(mcpErrors([stdio({ command: undefined })])[0]).toContain('command')
  })

  it('does not require https of a stdio server, which has no url at all', () => {
    expect(mcpErrors([stdio()])).toEqual([])
  })

  it('rejects a non-https url, which would leak a bearer token', () => {
    expect(mcpErrors([http({ url: 'http://x.example/mcp' })])[0]).toContain('https')
  })

  it('rejects the same name twice, which would collide in the overlay', () => {
    expect(mcpErrors([stdio(), stdio()])[0]).toContain('more than once')
  })

  it('checks a disabled server too, so a bad entry cannot be hidden by its switch', () => {
    expect(mcpErrors([stdio({ disabled: true, command: undefined })])).toHaveLength(1)
  })
})
