import type { Context } from '@deepseek-ai/cordis'
import type {} from './context.ts'
import { createArchHandler } from './rpc.ts'
import { registerArchTools } from './tools.ts'

/**
 * Required services.
 *
 * `connection` carries the channel, `workspaceRegistry` resolves a project,
 * `tools` takes the registrations. `webServer` is the subtle one: this package
 * never names it, but `ctx.connection.rpc.handle` registers its route through
 * the CALLER's context — `owner.webServer.register(route)` — and a cordis fiber
 * may only touch services it declares. Without it the harness refuses to boot
 * with "cannot get property webServer without inject".
 *
 * It is not discoverable from the type signature, which is why it survived a
 * verification pass that read the .d.ts rather than the implementation.
 */
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'tools']

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
  const workspaces = ctx.workspaceRegistry
  const handler = createArchHandler(workspaces)
  // Two arguments. An earlier draft passed `{ authority: 'loopback' }`; that
  // option was removed from the runtime and no longer exists.
  ctx.connection.rpc.handle('/arch', async (endpoint, payload) => handler(endpoint, payload))

  registerArchTools(ctx, workspaces)
}
