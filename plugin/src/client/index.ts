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
 * The button decides for itself whether to render: outside the desktop app
 * there is no pane, and it returns null.
 * @param ctx - the client context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'desktop-pane' }, PaneButton),
  )
}
