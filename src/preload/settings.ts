import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The settings renderer's entire capability surface.
 *
 * Three operations reach the main process, plus two receive-only
 * subscriptions. The renderer has no `fs`, no path construction, and no way
 * to write anything: every value it can persist goes through `save`, which
 * validates in main. `onProgress`/`onUpdateAvailable` add no way to *call*
 * into main — they only let the renderer listen for what main chooses to
 * push, each returning an unsubscribe function.
 */
contextBridge.exposeInMainWorld('settings', {
  read: () => ipcRenderer.invoke('settings:read'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  save: (form: unknown) => ipcRenderer.invoke('settings:save', form),
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
})
