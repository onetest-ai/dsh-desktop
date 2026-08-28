import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the window's own page may ask of main.
 *
 * The dividers and the rail are all this page renders, so it can drag a
 * divider, nudge one, ask for the result to be stored, and show or hide a
 * column. It cannot read the config, reach a file, or touch any view.
 */
contextBridge.exposeInMainWorld('shell', {
  askTheme: () => ipcRenderer.send('theme:ask'),
  onTheme: (listener: (dark: boolean) => void) => {
    ipcRenderer.on('theme', (_event, dark: boolean) => listener(dark))
  },
  resizeColumn: (column: string, windowX: number) => ipcRenderer.send('shell:resize-column', column, windowX),
  nudgeColumn: (column: string, delta: number) => ipcRenderer.send('shell:nudge-column', column, delta),
  commitColumns: () => ipcRenderer.send('shell:commit-columns'),
  toggleFiles: () => ipcRenderer.send('shell:toggle-files'),
  toggleWeb: () => ipcRenderer.send('shell:toggle-web'),
  onPlaces: (listener: (places: Record<string, never>) => void) => {
    ipcRenderer.on('shell:places', (_event, places: Record<string, never>) => listener(places))
  },
})
