import type { Context } from '@deepseek-ai/cordis'
import type {} from './context.ts'
import { createArchHandler, type WorkspaceLookup } from './rpc.ts'
import { registerArchTools } from './tools.ts'

/**
 * Required services: the transport that carries the channel, the workspace
 * registry that resolves a project, and the tool registry.
 *
 * `connection` is listed because `apply` calls `ctx.connection.rpc.handle`: a
 * cordis fiber that uses a service it does not inject may mount before that
 * service exists.
 */
export const inject = ['connection', 'workspaceRegistry', 'tools']

/**
 * Node half: the store, the RPC channel, and the agent tools.
 *
 * The channel writes files in the user's project. It carries no authority
 * argument because the runtime authenticates every registered channel itself —
 * `handle` is documented as registering "one authenticated absolute channel
 * prefix", behind BrowserAuth and the Host/Origin fence.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  const workspaces = ctx.workspaceRegistry as unknown as WorkspaceLookup
  const handler = createArchHandler(workspaces)
  // Two arguments. An earlier draft passed `{ authority: 'loopback' }`; that
  // option was removed from the runtime and no longer exists.
  ctx.connection.rpc.handle('/arch', async (endpoint, payload) => handler(endpoint, payload))

  registerArchTools(ctx, workspaces)
}
