import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The settings renderer's entire capability surface.
 *
 * Ten operations reach the main process, plus three receive-only
 * subscriptions. The renderer has no `fs`, no path construction, and no way
 * to write anything: every value it can persist goes through `save` or
 * `acceptPluginUpdate`, both of which validate in main. `acceptPluginUpdate`
 * is distinct from `save` so accepting an update for a floating plugin can
 * move only that entry's installed version without touching its spec text —
 * routing it through `save` would mean rewriting the spec to carry a version,
 * which is exactly what pins an entry. `validatePlugin` is a fifth call-in:
 * it lets the row-based plugin list validate one spec against the same
 * grammar `save` re-checks, without installing anything and without handing
 * the renderer its own copy of that grammar. `validatePluginConfig` is a
 * sixth, the same live-check contract as `validatePlugin` but for a row's
 * config textarea. `checkBinaries` is a seventh: it spawns `pnpm
 * --version`/`npm --version` against the form's current path fields, in
 * main, and returns each outcome — the renderer never spawns anything
 * itself. `openConfigFile` is an eighth: it asks main to open `desktop.json`
 * in the OS-associated editor — the renderer never learns the path or
 * touches the filesystem itself, only the pass/fail outcome.
 * `setMcpToken`/`clearMcpToken` are the ninth and tenth: an MCP server's
 * token is the one value the renderer can persist that never goes through
 * `save`, because it is never part of the form and never reaches
 * `desktop.json` — main puts it straight into the OS keychain. The traffic is
 * one-way by design: a token can be written and cleared, never read back, so
 * a stored credential cannot be recovered through this window.
 * `onProgress`/`onUpdateAvailable`/`onPluginUpdateAvailable` add no way to
 * *call* into main — they only let the renderer listen for what main chooses
 * to push, each returning an unsubscribe function. `validatePlugin`,
 * `checkBinaries`, and `openConfigFile` add no new push channel: each
 * answers over its own `invoke`, like the other operations.
 */
contextBridge.exposeInMainWorld('settings', {
  read: () => ipcRenderer.invoke('settings:read'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  save: (form: unknown) => ipcRenderer.invoke('settings:save', form),
  acceptPluginUpdate: (pkg: string, version: string) =>
    ipcRenderer.invoke('settings:accept-plugin-update', pkg, version),
  validatePlugin: (spec: string, existingPackages: string[]) =>
    ipcRenderer.invoke('settings:validate-plugin', spec, existingPackages),
  validatePluginConfig: (text: string) => ipcRenderer.invoke('settings:validate-plugin-config', text),
  checkBinaries: (pnpmPath: string, npmPath: string) => ipcRenderer.invoke('settings:check-binaries', pnpmPath, npmPath),
  openConfigFile: () => ipcRenderer.invoke('settings:open-config-file'),
  setMcpToken: (id: string, token: string) => ipcRenderer.invoke('settings:set-mcp-token', id, token),
  clearMcpToken: (id: string) => ipcRenderer.invoke('settings:clear-mcp-token', id),
  onProgress: (listener: (line: string) => void) => {
    const handler = (_event: IpcRendererEvent, line: string): void => listener(line)
    ipcRenderer.on('settings:progress', handler)
    return () => ipcRenderer.removeListener('settings:progress', handler)
  },
  onUpdateAvailable: (listener: (latest: string) => void) => {
    const handler = (_event: IpcRendererEvent, latest: string): void => listener(latest)
    ipcRenderer.on('settings:update-available', handler)
    return () => ipcRenderer.removeListener('settings:update-available', handler)
  },
  onPluginUpdateAvailable: (listener: (pkg: string, latest: string) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { pkg: string; latest: string }): void =>
      listener(payload.pkg, payload.latest)
    ipcRenderer.on('settings:plugin-update-available', handler)
    return () => ipcRenderer.removeListener('settings:plugin-update-available', handler)
  },
})
