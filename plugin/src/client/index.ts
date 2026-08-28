import type { Context } from '@deepseek-ai/cordis'
import { appendToComposer } from './composer.ts'
import { desktop } from './desktop.ts'

/**
 * Browser half: pick up what the desktop app's tree hands over.
 *
 * It contributes no UI. The desktop app draws its own controls, on its own
 * rail, and a second pair of buttons in the harness's sidebar was two places
 * to toggle one thing.
 *
 * Outside that app this does nothing at all: the bridge it subscribes to is
 * something that app's preload puts on the page, and it is absent everywhere
 * else.
 * @param _ctx - the client context, unused.
 */
export function apply(_ctx: Context): void {
  desktop()?.onAddToChat?.((reference) => {
    appendToComposer(reference.path)
  })
}
