# Startup healthcheck and repair — design

## Problem

`desktop.json` declares what should be installed; `$DSH_HOME/runtimes` holds what actually is. Nothing reconciles them. Plugins install only inside a Settings save, so a plugin that is declared but absent — added by a config edit, a shipped default, or files removed under `$DSH_HOME` — is reported by the Plugins tab as a failure the user did nothing to cause:

> Disabled — the harness would not start with it: dsh-project-mcp-bridge is not installed yet; save Settings once to install it.

This blocked shipping `dsh-project-mcp-bridge` as a default: declaring a default is not installing one.

Three further gaps share the cause:

- **The window is blank for up to 60 seconds** while the harness boots (`READY_TIMEOUT_MS`), with only a tray dot indicating anything.
- **Update checks run only when Settings opens** — a user who never opens it is never offered one.
- **`preflight()` checks only the harness source.** Binaries, the shell-PATH cache, and plugin installation are unchecked until something fails.

## Shape

A startup phase that runs before the harness boots, renders in the main window, and reconciles declared state with actual state.

**Repair before boot.** A harness never starts with half its plugins: a session that begins without its MCP servers, then gets restarted underneath, is the silent-degradation class this project has been removing. The cost is that a first launch after adding a plugin waits on `npm` — minutes on a cold install — which the screen explains rather than hiding.

**Phases, in order.** Each reports into the same surface:

1. **Preflight** — the existing `preflight()`: harness source present, and for a local source its frontend built.
2. **Healthcheck** — read-only findings: `pnpm`/`npm` resolvable, shell-PATH cache present, every declared plugin installed and loadable.
3. **Repair** — install what is missing, streaming `npm` output.
4. **Boot** — the existing `bootNow()`, then the harness URL replaces the screen.

**Findings are data, not prose.** `runHealthcheck` returns a list of typed findings with a severity and, where one exists, a repair action. The renderer decides presentation; nothing decides policy in the view.

**Failure never traps the user.** A finding that cannot be repaired — an unreachable registry, a missing checkout — leaves the screen showing what failed, with Open Settings and Continue Anyway. Continuing boots the harness with the plugins that did install, which is exactly today's behaviour.

**Update checks move here**, non-blocking: the result arrives after boot and is surfaced as a notice, never as a gate.

## Constraints this must respect

- **`quitting` is re-checked after every await.** A quit landing mid-install must not spawn further work; `install-process.ts`'s runner already refuses after `stopAll`, and the phase must not queue past it.
- **No new install path.** Repair reuses `installPlugin` and `pluginStatus`, so an entry repaired at startup is indistinguishable from one installed by a save.
- **Findings never mutate config.** Repair installs packages; it does not rewrite `desktop.json`. Reinstating shipped defaults stays `ensureDefaultPlugins`'s job, ordered before the healthcheck so a newly added default is seen as missing and repaired in the same pass.
- **The surface is Electron, not a harness plugin.** It runs before the harness exists and is the recovery path when the harness cannot start.

## Once this lands

`DEFAULT_PLUGIN_SPECS` regains `PROJECT_MCP_BRIDGE`. The constant and the generation marker already exist; the only reason the set is empty is that nothing installed what it declared.

## Out of scope

- Retiring the Electron MCP tab for an adopted harness MCP UI plugin. That needs the adoption decision first, and a plan of its own: our tab and any such plugin both emit `dsh-mcp-client` rows, and a duplicate `serverName` is fatal in the official client — so exactly one writer may remain.
- Repairing the harness install itself. A managed harness already resolves and installs on save; a broken one is a Settings problem the screen links to.
