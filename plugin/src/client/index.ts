import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Pulls in ui-sidebar's `declare module` augmentation, which is what declares
// the `'sidebar.footer.action'` slot name this registers against.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// ui-sidebar's own slots are declared under ui-layout's top-level `'sidebar'`
// name, so its augmentation has to be pulled in as well for the chain to
// typecheck.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { PaneButton } from './PaneButton.tsx'
import { appendToComposer } from './composer.ts'
import { desktop } from './desktop.ts'

/** Required service: the slot registry. */
export const inject = ['slots']

/**
 * Browser half: one button beside Settings at the sidebar foot.
 *
 * `sidebar.footer.action` is a list slot, so this sits alongside whatever
 * else contributes there rather than replacing it. `slots.inject` waits for
 * the declaration instead of assuming apply order, and withdraws the button
 * if the sidebar goes away.
 *
 * The buttons decide for themselves whether to render: outside the desktop
 * app there are no panels, and they return null. The subscription below is
 * likewise a no-op there, since the bridge that carries it is absent.
 * @param ctx - the client context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'desktop-pane' }, PaneButton),
  )
  // A path the user picked in the desktop app's tree, put where they were
  // going to type it. Subscribed once, outside any slot: the message box
  // belongs to the page, not to this plugin's own component.
  desktop()?.onAddToChat?.((reference) => {
    appendToComposer(reference.path)
  })
}
