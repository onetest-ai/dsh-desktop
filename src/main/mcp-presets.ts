/**
 * The MCP servers this app offers out of the box.
 *
 * A preset is data, never code: every entry is a remote Streamable HTTP
 * server reached over one URL, so adding a vendor is one row here. Nothing
 * in this module knows about any particular service beyond what the row
 * states.
 *
 * The `auth` field is the load-bearing distinction. A `token` preset accepts
 * a long-lived credential the user can paste (a personal access token, an
 * API key), which is all this app can carry today. An `oauth` preset issues
 * no such credential at all — its `401` names OAuth as the only accepted
 * scheme — so it is listed but not selectable, and stays that way until the
 * app can run an authorization flow. Listing it disabled is deliberate: a
 * token field for a server that accepts no token is a dead end the user
 * would only discover after pasting something.
 */
export interface McpPreset {
  /** Stable id, used as the server's default id and as its tool namespace. */
  id: string
  /** Name shown in the settings picker. */
  label: string
  /** The server's Streamable HTTP endpoint. */
  url: string
  /** Where the user gets a credential, or reads about the server. */
  docs: string
  /** Whether a pasteable credential exists (`token`) or only OAuth does (`oauth`). */
  auth: 'token' | 'oauth'
  /** What the credential is called by this vendor; shown as the field's label. Set only for `token`. */
  tokenLabel?: string
}

/**
 * Every offered preset, in the order the settings picker lists them:
 * usable ones first, then the ones awaiting OAuth support.
 *
 * The `oauth` rows are not aspirational placeholders — each was probed
 * directly and answers an unauthenticated `initialize` with
 * `WWW-Authenticate: Bearer realm="OAuth"` and no other accepted scheme (see
 * `docs/notes/mcp-servers.md`).
 */
export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'tavily',
    label: 'Tavily (web search)',
    url: 'https://mcp.tavily.com/mcp/',
    docs: 'https://app.tavily.com/home',
    auth: 'token',
    tokenLabel: 'API key',
  },
  {
    id: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    docs: 'https://github.com/settings/personal-access-tokens',
    auth: 'token',
    tokenLabel: 'Personal access token',
  },
  {
    id: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    docs: 'https://linear.app/docs/mcp',
    auth: 'oauth',
  },
  {
    id: 'atlassian',
    label: 'Atlassian (Jira & Confluence)',
    url: 'https://mcp.atlassian.com/v1/mcp',
    docs: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    auth: 'oauth',
  },
]

/**
 * Look up a preset by id.
 * @param id - the preset id, as stored on a server entry.
 * @returns the preset, or undefined when no row declares that id.
 */
export function findPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id)
}

/**
 * The presets a user can actually add today: those issuing a credential
 * this app can carry.
 * @returns every `token` preset, in declaration order.
 */
export function selectablePresets(): McpPreset[] {
  return MCP_PRESETS.filter((preset) => preset.auth === 'token')
}
