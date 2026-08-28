import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the harness page is told by this app.
 *
 * One subscription, carrying a path the user picked in this app's own file
 * tree. The page cannot toggle a column or read a file through this: the
 * controls for that are this app's own, on its rail, and the harness page
 * hosts other packages' browser halves — so what it can reach is kept to the
 * one thing it is for.
 *
 * Its presence is also how the desktop plugin's browser half knows it is
 * running inside this app rather than in a plain browser.
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  onAddToChat: (listener: (reference: { path: string; directory: boolean }) => void) => {
    ipcRenderer.on('harness:add-to-chat', (_event, reference: { path: string; directory: boolean }) =>
      listener(reference),
    )
  },
})
