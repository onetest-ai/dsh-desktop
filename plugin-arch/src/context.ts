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
 * The harness's own packages contribute these by declaration merging, but this
 * package deliberately does NOT depend on them: the published versions are five
 * minors behind the runtime the app actually loads (npm 0.0.1-rc.1 against
 * runtime 0.1.5-rc.2), so compiling against them would typecheck this plugin
 * against types that are known to be wrong. That is the same trap that had
 * `rpc.handle` documented with a third `authority` argument the real runtime
 * had already removed.
 *
 * So: declare only the surface actually used, verified by hand against
 * `~/.dsh/runtimes/.../0.1.5-rc.1`. The trade is explicit — this file will not
 * notice a runtime change on its own, so RUNTIME-VERIFICATION.md is the thing
 * to re-run when the managed harness updates.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: ConnectionHost
    workspaceRegistry: WorkspaceLookup
    tools: ToolHost
  }
}
