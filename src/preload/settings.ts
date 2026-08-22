import { contextBridge, ipcRenderer } from 'electron'

/**
 * The settings renderer's entire capability surface.
 *
 * Exactly three operations reach the main process. The renderer has no `fs`,
 * no path construction, and no way to write anything: every value it can
 * persist goes through `save`, which validates in main.
 */
contextBridge.exposeInMainWorld('settings', {
  read: () => ipcRenderer.invoke('settings:read'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  save: (form: unknown) => ipcRenderer.invoke('settings:save', form),
})
