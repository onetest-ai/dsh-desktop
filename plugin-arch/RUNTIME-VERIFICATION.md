# Runtime API verification

Checked against the **managed** harness at
`~/.dsh/runtimes/QGRlZXBzZWVrLWFpL2RzaA/MC4xLjUtcmMuMQ` (base64-keyed path for
`@deepseek-ai/dsh` version `0.1.5-rc.1`; every `@deepseek-ai/*` sub-package inside it
individually reports `0.1.5-rc.2`). This is the newest of three cached runtime
builds (`0.1.1-rc.2`, `0.1.2-rc.1`, `0.1.5-rc.1` also present under the same key) and
the one this app actually loads.

**This tree, not `plugin/node_modules/@deepseek-ai/*`, is the source of truth.** The
checked-in `plugin/node_modules` copy of `dsh-client-connection` is pinned at
`0.1.1-rc.2` — one runtime generation stale — and disagrees with the managed runtime
on the RPC surface (see below). Always re-check against
`~/.dsh/runtimes/<base64 package key>/<base64 version>` directly; do not trust a
`plugin/node_modules` copy for this design's runtime facts.

| API | Package | Present | Notes |
| --- | --- | --- | --- |
| `shell.overlay` slot | dsh-client-ui-layout | yes | `PropsRenderSlots<... \| 'shell.overlay'>` in `client/AppFrame.d.ts:4`; keyed in the slot map in `client/index.d.ts:80`. |
| `sidebar.footer.action` slot | dsh-client-ui-sidebar | yes | Keyed in the slot map in `client/contract/slots.d.ts:69`; also in `SidebarRootComponentProps`'s `PropsRenderSlots` union at `slots.d.ts:150`. |
| `ctx.connection.rpc.handle` | dsh-client-connection | yes | `HostConnectionHandle.rpc: HostConnectionRpc` (module augmentation of `ctx.connection` in `rpc-host.d.ts:5-8`); `HostConnectionRpc.handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>` — **two parameters** — at `rpc.d.ts:111`. Its doc comment reads "Register one authenticated absolute channel prefix" (`rpc.d.ts:106-110`). |
| `ctx.connection.rpc.handle` per-channel `authority` option | dsh-client-connection | **removed** | The 0.1.1-rc.2 signature took a third `options: ConnectionRpcHandlerOptions` argument carrying `authority: ConnectionRpcAuthority` (`'trusted-host' \| 'loopback'`) — confirmed still present in the stale `plugin/node_modules/@deepseek-ai/dsh-client-connection@0.1.1-rc.2` copy (`rpc.d.ts:4,7-8,23`). In the managed 0.1.5-rc.2 tree neither `ConnectionRpcAuthority` nor `ConnectionRpcHandlerOptions` exists, and the string `authority` does not appear anywhere in `rpc.d.ts` (confirmed by grep over the whole `dsh-client-connection/lib/types/` tree — the only `authority` hits are in unrelated files: `browser-auth.d.ts`, `api-request-trust.d.ts`, `loopback-hostname.d.ts`, `index.d.ts`, `client/index.d.ts`). Every registered channel is now authenticated by default instead of opting in per-tag: `HostConnectionService` (`rpc-host.d.ts`) composes a `BrowserAuth` (`browser-auth.d.ts` — process launch-token exchange plus a persistent signed browser cookie, `isAuthenticated`/`authorizeIndex`/`authenticatedUrl`) with a configured `trustedHosts` Host/Origin fence (`requestRejection`, `rpc-host.d.ts:29`, `rpc.d.ts:139`), rather than taking a per-`handle()` authority tag. |
| `ConnectionRpcResult` failure shape | dsh-client-connection | recorded for later use | `ConnectionRpcResult<T> = { ok: true, value: T } \| { ok: false, error: ConnectionRpcFailure }`, and `ConnectionRpcFailure = { code: string; message: string; details: object }` — a **structured object**, not a string (`rpc.d.ts:11-25`). A later task (Task 9) returns this shape from a registered `handle()`. |
| `ctx.workspaceRegistry.get` | dsh-workspace | yes | `Context.workspaceRegistry: WorkspaceRegistry` module augmentation in `index.d.ts`; `WorkspaceRegistry.get(id: WorkspaceId): Workspace \| undefined` at `index.d.ts:85`. |
| `ctx.tools.register` | dsh-tools | yes | `Context.tools: ToolRuntime` module augmentation at `index.d.ts:24-26`; `register(definition: ToolDefinition): () => void` at `index.d.ts:601`. |
| `ctx.attachments.saveImage` | dsh-attachment | yes (Plan 2) | `abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>` at `index.d.ts:72`; batch form `saveImages(inputs: readonly SaveImageAttachment[])` at `index.d.ts:42`. |

Re-run this check whenever the managed runtime updates.
