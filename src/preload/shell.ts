import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the window's own page may ask of main.
 *
 * Three calls, all about column widths: the dividers are the only thing this
 * page renders, so it can drag one, nudge one, and ask for the result to be
 * stored. It cannot read the config, reach a file, or touch any view.
 */
contextBridge.exposeInMainWorld('shell', {
  resizeColumn: (column: string, windowX: number) => ipcRenderer.send('shell:resize-column', column, windowX),
  nudgeColumn: (column: string, delta: number) => ipcRenderer.send('shell:nudge-column', column, delta),
  commitColumns: () => ipcRenderer.send('shell:commit-columns'),
  onDividers: (listener: (places: Record<string, { x: number; width: number }>) => void) => {
    ipcRenderer.on('shell:dividers', (_event, places: Record<string, { x: number; width: number }>) =>
      listener(places),
    )
  },
})
