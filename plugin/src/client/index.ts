import type { Context } from '@deepseek-ai/cordis'
// Pulls in the client runtime's `declare module`, which is what types
// `ctx.sessions` — the session list, and which of them is open.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { appendToComposer } from './composer.ts'
import { followCurrentWorkspace } from './current-workspace.ts'
import { desktop } from './desktop.ts'

/** Required service: the session list, which knows what the user is looking at. */
export const inject = ['sessions']

/**
 * Browser half: the two things that have to happen inside the harness page.
 *
 * It contributes no UI. The desktop app draws its own controls, on its own
 * rail, and a second pair of buttons in the harness's sidebar was two places
 * to toggle one thing.
 *
 * Outside that app both halves do nothing: the bridge they use is something
 * that app's preload puts on the page, and it is absent everywhere else.
 * @param ctx - the client context.
 */
export function apply(ctx: Context): void {
  const bridge = desktop()
  if (bridge === undefined) return

  bridge.onAddToChat((reference) => {
    appendToComposer(reference.path)
  })

  // Which project the desktop app's tree shows. Reported from here because
  // this is where the answer is: switching to an existing session changes
  // nothing on disk for that app to notice. Registered as an effect, so
  // unloading this plugin takes the subscription with it rather than leaving
  // one on a service that outlives it.
  ctx.effect(() =>
    followCurrentWorkspace(ctx.sessions.list, (cwd) => {
      bridge.setWorkspace?.(cwd)
    }),
  )
}
