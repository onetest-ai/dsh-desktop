import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The settings renderer's entire capability surface.
 *
 * Four operations reach the main process, plus three receive-only
 * subscriptions. The renderer has no `fs`, no path construction, and no way
 * to write anything: every value it can persist goes through `save` or
 * `acceptPluginUpdate`, both of which validate in main. `acceptPluginUpdate`
 * is distinct from `save` so accepting an update for a floating plugin can
 * move only that entry's installed version without touching its spec text —
 * routing it through `save` would mean rewriting the spec to carry a version,
 * which is exactly what pins an entry.
 * `onProgress`/`onUpdateAvailable`/`onPluginUpdateAvailable` add no way to
 * *call* into main — they only let the renderer listen for what main chooses
 * to push, each returning an unsubscribe function.
 */
contextBridge.exposeInMainWorld('settings', {
  read: () => ipcRenderer.invoke('settings:read'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  save: (form: unknown) => ipcRenderer.invoke('settings:save', form),
  acceptPluginUpdate: (pkg: string, version: string) =>
    ipcRenderer.invoke('settings:accept-plugin-update', pkg, version),
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
