import { contextBridge, ipcRenderer } from 'electron'

/**
 * The one thing the harness page may ask of this app.
 *
 * The harness Web UI is loaded unmodified and hosts other packages' browser
 * halves, so what it can reach is kept to a single no-argument call that
 * shows or hides this app's own pane. It reads nothing, takes no path, and
 * returns nothing.
 *
 * Its presence is also the signal a harness-side button uses to decide
 * whether to render at all: in a plain browser there is no pane to toggle,
 * and `window.dshDesktop` is undefined there.
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  togglePane: () => ipcRenderer.send('harness:toggle-pane'),
})
