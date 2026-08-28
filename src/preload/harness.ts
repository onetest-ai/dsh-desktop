import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the harness page is told by this app.
 *
 * Two calls, both about which project is in front of the user: one carrying
 * a path they picked in this app's file tree, and one reporting the directory
 * the open session works in. The page cannot toggle a column or read a file
 * through this — the controls for that are this app's own, on its rail — and
 * the harness page hosts other packages' browser halves, so what it can reach
 * stays this narrow.
 *
 * Its presence is also how the desktop plugin's browser half knows it is
 * running inside this app rather than in a plain browser.
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  setWorkspace: (cwd: string) => ipcRenderer.send('harness:workspace', cwd),
  onAddToChat: (listener: (reference: { path: string; directory: boolean }) => void) => {
    ipcRenderer.on('harness:add-to-chat', (_event, reference: { path: string; directory: boolean }) =>
      listener(reference),
    )
  },
})
