# Runtime API verification

Checked against the managed harness at `$DSH_HOME/runtimes/@deepseek-ai/dsh/0.1.5-rc.1`
(the newest of the three cached runtime builds — 0.1.1-rc.2, 0.1.2-rc.1, 0.1.5-rc.1 —
each individual package pinned at `0.1.5-rc.2`).

| API | Package | Present | Notes |
| --- | --- | --- | --- |
| `shell.overlay` slot | dsh-client-ui-layout | yes | `PropsRenderSlots<... \| 'shell.overlay'>` in `client/AppFrame.d.ts`; also keyed in the slot map in `client/index.d.ts:80`. |
| `sidebar.footer.action` slot | dsh-client-ui-sidebar | yes | Keyed in the slot map in `client/contract/slots.d.ts:69`, and listed in `SidebarRootComponentProps`'s `PropsRenderSlots` union. |
| `ctx.connection.rpc.handle` | dsh-client-connection | yes | `HostConnectionHandle.rpc: HostConnectionRpc` (`rpc-host.d.ts`, augmenting `ctx.connection`); `HostConnectionRpc.handle(channel, handler)` in `rpc.d.ts:111`. |
| `ctx.workspaceRegistry.get` | dsh-workspace | yes | `Context.workspaceRegistry: WorkspaceRegistry` module augmentation in `index.d.ts`; `WorkspaceRegistry.get(id: WorkspaceId): Workspace \| undefined` in `index.d.ts:85`. |
| `ctx.tools.register` | dsh-tools | yes | `Context.tools: ToolRuntime` module augmentation; `register(definition: ToolDefinition): () => void` in `index.d.ts:601`. |
| `ctx.attachments.saveImage` | dsh-attachment | yes | (Plan 2) `saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>` abstract method in `index.d.ts:72` (plural `saveImages` batch form also present at `index.d.ts:42`). |

Re-run this check whenever the managed runtime updates.
