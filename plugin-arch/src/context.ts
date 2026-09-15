import type { ArchResult, WorkspaceLookup } from './rpc.ts'

/**
 * The part of the harness's tool registry this plugin uses.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-tools` so Task 10
 * and the Context augmentation share one definition.
 */
export interface ToolHost {
  register(definition: {
    name: string
    description: string
    parameters: object
    execute(args: Record<string, unknown>): Promise<unknown>
  }): () => void
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
 * The three services this plugin reads off the cordis Context.
 *
 * The harness's own packages contribute these by declaration merging, and this
 * package deliberately does not depend on them. Not because they are
 * unavailable — the registry does publish the runtime's exact version — but
 * because a plugin is loaded into whichever harness the user happens to run.
 * Pinning a devDependency to one version would typecheck against a snapshot
 * that goes stale on their next update, while making a green build look like
 * evidence of runtime compatibility. It is not.
 *
 * So: declare only the surface actually used, verified by hand against the
 * managed runtime. The trade is explicit — this file cannot notice a runtime
 * change on its own, so RUNTIME-VERIFICATION.md is the thing to re-run when the
 * harness updates. That document, not the type checker, is what caught
 * `rpc.handle` losing its third argument.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: ConnectionHost
    workspaceRegistry: WorkspaceLookup
    tools: ToolHost
  }
}
