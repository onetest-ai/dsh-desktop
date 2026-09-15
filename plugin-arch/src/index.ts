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
 * The `ctx.inject` mixin, typed by hand.
 *
 * `@deepseek-ai/cordis` genuinely declares this on `Context` — it is mixed in
 * from `RegistryService` by a `declare module './context.ts'` augmentation
 * inside the package's own `registry.d.ts`, alongside `plugin`. But whichever
 * file in THIS package is the first to reference the merged `Context` type
 * sees it without that mixin (confirmed by moving the reference between
 * files: the first one always fails, a second reference elsewhere always
 * resolves correctly) — a TypeScript resolution-order quirk between our own
 * `declare module '@deepseek-ai/cordis'` augmentation (context.ts) and
 * cordis's internal relative one, not a real gap in the runtime or in
 * cordis's types. `apply` is that first reference, so it is cast through this
 * narrow, hand-written shape rather than left unresolved.
 */
type Injectable = { inject(deps: string[], callback: (ctx: Context) => void): unknown }

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
  // Registered inside a `webServer` injection rather than called directly.
  // `ctx.connection.rpc`'s getter captures the context the SERVICE is bound
  // to and registers its route through that context's `webServer` — so a
  // module-level `inject` entry is not enough, and the harness refuses to
  // boot with "cannot get property webServer without inject" even though
  // `ctx.webServer` is reachable from here. Injecting explicitly gives the
  // getter a context that carries the service. This mirrors how
  // dsh-client-connection registers its own `/api` route.
  ;(ctx as Context & Injectable).inject(['webServer'], (webCtx) => {
    // Two arguments. An earlier draft passed `{ authority: 'loopback' }`; that
    // option was removed from the runtime and no longer exists.
    webCtx.connection.rpc.handle('/arch', async (endpoint, payload) => handler(endpoint, payload))
  })

  registerArchTools(ctx, workspaces)
}
