import type { Context } from '@deepseek-ai/cordis'

/**
 * Node half: deliberately empty.
 *
 * Everything this package does happens in the browser half, which talks to the
 * desktop app through that app's own preload. The node row exists only so the
 * loader resolves this package and the client module system finds its
 * `dsh.client` declaration.
 * @param _ctx - the plugin context, unused.
 */
export function apply(_ctx: Context): void {}
