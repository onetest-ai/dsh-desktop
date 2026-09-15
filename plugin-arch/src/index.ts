import type { Context } from '@deepseek-ai/cordis'

/**
 * Node half: the store, the RPC channel, and the agent tools.
 *
 * Empty until Task 8 wires the channel in. It exists from the first commit so
 * the plugin row resolves and the package is loadable while the store beneath
 * it is still being built — a half-finished plugin that fails to load teaches
 * nothing about the half that is finished.
 * @param _ctx - the plugin context, unused for now.
 */
export function apply(_ctx: Context): void {}
