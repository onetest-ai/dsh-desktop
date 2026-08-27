import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the pane may ask of main.
 *
 * The pane is this app's own page, but it is still a renderer: it reaches no
 * file and no configuration directly. Every call here names an operation main
 * performs and checks — reading a directory, reading and writing a file — and
 * main roots each one in a project the harness has opened.
 */
contextBridge.exposeInMainWorld('pane', {
  showWebView: (visible: boolean) => ipcRenderer.send('pane:show-web-view', visible),
})
