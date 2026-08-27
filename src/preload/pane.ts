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
  projects: () => ipcRenderer.invoke('pane:projects'),
  listDirectory: (root: string, relative: string) => ipcRenderer.invoke('pane:list-directory', root, relative),
  openFile: (root: string, relative: string) => ipcRenderer.send('pane:open-file', root, relative),
  readFile: (root: string, relative: string) => ipcRenderer.invoke('pane:read-file', root, relative),
  writeFile: (root: string, relative: string, text: string) =>
    ipcRenderer.invoke('pane:write-file', root, relative, text),
  onOpenFile: (listener: (root: string, relative: string) => void) => {
    ipcRenderer.on('pane:open', (_event, root: string, relative: string) => listener(root, relative))
  },
  onFileChanged: (listener: (root: string, relative: string) => void) => {
    ipcRenderer.on('pane:file-changed', (_event, root: string, relative: string) => listener(root, relative))
  },
})
