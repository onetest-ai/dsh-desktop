import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the window's own page may ask of main.
 *
 * Three calls, all about one number: the divider is the only thing this page
 * renders, so it can move the pane, nudge it, and ask for the new width to be
 * stored. It cannot read the config, reach a file, or touch either view.
 */
contextBridge.exposeInMainWorld('shell', {
  resizePane: (windowX: number) => ipcRenderer.send('shell:resize-pane', windowX),
  nudgePane: (delta: number) => ipcRenderer.send('shell:nudge-pane', delta),
  commitPane: () => ipcRenderer.send('shell:commit-pane'),
})
