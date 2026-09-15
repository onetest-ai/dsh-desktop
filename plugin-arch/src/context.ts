import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ArchResult, WorkspaceLookup } from './rpc.ts'

/**
 * The part of the harness's tool registry this plugin uses.
 *
 * Typed against `ToolDefinition` from `@deepseek-ai/dsh-tools` itself, not a
 * hand-written approximation: a definition built any other way cannot satisfy
 * `register` at runtime (`dsh-tools` requires the mandatory `output: { schema,
 * render }` its own `defineTool` compiles in), and a narrower hand-rolled type
 * hid exactly that mismatch from the compiler until the real harness refused
 * to load this plugin. `defineTool` (also from `@deepseek-ai/dsh-tools`) is
 * how `tools.ts` builds a value this interface actually accepts.
 */
export interface ToolHost {
  register(definition: ToolDefinition): () => void
}

/** The part of the harness's connection service this plugin uses. */
export interface ConnectionHost {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ArchResult>,
    ): () => Promise<void>
  }
}

/**
 * The two remaining services this plugin reads off the cordis Context that it
 * does NOT depend on the declaring package for.
 *
 * The harness's own packages contribute these by declaration merging, and this
 * package deliberately does not depend on `connection`'s or
 * `workspaceRegistry`'s owning packages. Not because they are unavailable —
 * the registry does publish the runtime's exact version — but because a
 * plugin is loaded into whichever harness the user happens to run. Pinning a
 * devDependency to one version would typecheck against a snapshot that goes
 * stale on their next update, while making a green build look like evidence
 * of runtime compatibility. It is not.
 *
 * `tools` used to be declared here too, narrowly, for the same reason — until
 * that narrow re-declaration turned out to be exactly what hid the real
 * `dsh-tools` registration contract from the compiler (see `ToolHost` above).
 * Fixing that meant taking a real dependency on `@deepseek-ai/dsh-tools`, and
 * that package's own `.d.ts` already merges `Context.tools: ToolRuntime` the
 * moment it is imported anywhere in this program — TypeScript refuses two
 * declarations of the same Context property with different types, so
 * `tools` is deliberately ABSENT from the block below now: declaring it here
 * too would conflict with the one `dsh-tools` supplies, not coexist with it.
 *
 * So: declare only the surface actually used for what this package does not
 * otherwise depend on, verified by hand against the managed runtime. The
 * trade is explicit — this file cannot notice a runtime change on its own, so
 * RUNTIME-VERIFICATION.md is the thing to re-run when the harness updates.
 * That document, not the type checker, is what caught `rpc.handle` losing its
 * third argument.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: ConnectionHost
    workspaceRegistry: WorkspaceLookup
  }
}
