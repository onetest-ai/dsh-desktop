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
| `ctx.connection.rpc.handle` must be called from inside `ctx.inject(['webServer'], …)` | dsh-client-connection | **found only by booting the real harness** | Its `rpc` getter captures the context the *service* is bound to and registers the route through **that** context's `webServer`, so a module-level `inject` entry does not reach it — the harness refuses to boot even though `ctx.webServer` is accessible from the plugin body. A first attempt added `webServer` to the module-level `inject` array alone; a mount probe confirmed `ctx.webServer` was reachable from `apply`, and the harness still failed to boot with the same "cannot get property webServer without inject" error, because the throw comes from inside `dsh-client-connection`'s own service getter, bound to a different context than the one carrying our `inject`. The fix is the scoped form `ctx.inject(['webServer'], (webCtx) => webCtx.connection.rpc.handle(...))`, mirroring how `dsh-client-connection` registers its own `/api` route. Found by booting; invisible to the `.d.ts`, to unit tests, and to a hand-built `ctx` double. |

Re-run this check whenever the managed runtime updates.

**Verifying a runtime API means reading the implementation for what it does to the
caller's context, not only the `.d.ts` for its signature — and even that is not enough.**
The `authority` argument change above was caught by reading types, and that was
sufficient. The `webServer` module-level `inject` requirement was found by reading
`dsh-client-connection/lib/index.js` after the harness failed to boot, but that reading
was itself incomplete: a second read of the same file, plus a mount probe confirming
`ctx.webServer` was reachable, still missed that the service's own `rpc` getter is bound
to a different context than the caller's. A runtime API's requirements are not only in
its signature or even its implementation's first line — the only complete check is
loading the plugin into the real harness and watching it boot. Two verification passes
and a mount probe missed this; booting caught it.

**A TypeScript quirk found while fixing the `webServer` boot failure:** with the scoped
`ctx.inject(['webServer'], (webCtx) => …)` form in place, `tsc` reported `Property
'inject' does not exist on type 'Context'` at that exact call — even though `inject` is
genuinely part of `@deepseek-ai/cordis`'s `Context` (mixed in from `RegistryService` via
cordis's own internal `declare module './context.ts'` augmentation, same mechanism as
`plugin`). Reproduced deterministically: whichever file in `plugin-arch/src` is the
FIRST, in file-processing order, to reference the merged `Context` type sees it without
this mixin; a second reference anywhere else in the package resolves it completely, and
moving that second reference before or after `index.ts` in processing order turns the
first file's diagnostic on and off. This looks like an ordering interaction between our
own `declare module '@deepseek-ai/cordis'` augmentation in `context.ts` and cordis's
internal relative-path one, not a real gap in cordis's types or in the runtime — plugged
with a narrow, hand-written `Injectable` type and a cast at the one call site in
`index.ts`, documented there. If this resurfaces (e.g. a future task adds another file
that is checked before `index.ts` and also references `Context`), that is the same
quirk, not a new one.

**A trap in checking the registry:** `npm view <pkg> version` prints the `latest`
dist-tag, not the newest published version — these packages pin `latest` at an old
`0.0.1-rc.1` release, which makes the registry look five minors behind the managed
runtime when it is not. `npm view <pkg> versions` (plural) lists every published
version, and it does carry the runtime's exact version (e.g. `0.1.5-rc.2` for
`dsh-client-connection`, matching this tree). That a version is installable is not the
point, though: `plugin-arch/src/context.ts` still declares this surface locally rather
than depending on the real packages, because a plugin loads into whichever harness the
user happens to run, not the one pinned at `npm install` time — see that file's doc
comment.
