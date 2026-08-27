import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the harness page may ask of this app.
 *
 * The harness Web UI is loaded unmodified and hosts other packages' browser
 * halves, so what it can reach is kept to two no-argument calls that show or
 * hide this app's own columns. Neither reads anything, takes a path, or
 * returns anything.
 *
 * Its presence is also the signal a harness-side button uses to decide
 * whether to render at all: in a plain browser there is nothing to toggle,
 * and `window.dshDesktop` is undefined there.
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  toggleFiles: () => ipcRenderer.send('harness:toggle-files'),
  toggleWeb: () => ipcRenderer.send('harness:toggle-web'),
})
