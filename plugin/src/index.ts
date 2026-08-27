import type { Context } from '@deepseek-ai/cordis'

/**
 * Node half: deliberately empty.
 *
 * The plugin row exists so the loader resolves this package and the client
 * module system finds its `dsh.client` declaration. The button itself is
 * browser-only, and it talks to the desktop app through that app's own
 * preload rather than through anything the harness runs.
 * @param _ctx - the plugin context, unused.
 */
export function apply(_ctx: Context): void {}
