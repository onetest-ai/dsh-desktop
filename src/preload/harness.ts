import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the harness page may ask of this app, and be told by it.
 *
 * The harness Web UI is loaded unmodified and hosts other packages' browser
 * halves, so this is kept to two no-argument calls that show or hide a
 * column, and one subscription carrying a path the user asked to reference.
 * Nothing here reads a file or returns one.
 *
 * Its presence is also the signal a harness-side button uses to decide
 * whether to render at all: in a plain browser there is nothing to toggle,
 * and `window.dshDesktop` is undefined there.
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  toggleFiles: () => ipcRenderer.send('harness:toggle-files'),
  toggleWeb: () => ipcRenderer.send('harness:toggle-web'),
  onAddToChat: (listener: (reference: { path: string; directory: boolean }) => void) => {
    ipcRenderer.on('harness:add-to-chat', (_event, reference: { path: string; directory: boolean }) =>
      listener(reference),
    )
  },
})
