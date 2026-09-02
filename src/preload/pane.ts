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
  askTheme: () => ipcRenderer.send('theme:ask'),
  onTheme: (listener: (dark: boolean) => void) => {
    ipcRenderer.on('theme', (_event, dark: boolean) => listener(dark))
  },
  showWebView: (visible: boolean) => ipcRenderer.send('pane:show-web-view', visible),
  askProject: () => ipcRenderer.send('pane:ask-project'),
  onProject: (listener: (project: { path: string; title: string } | undefined) => void) => {
    ipcRenderer.on('pane:project', (_event, project: { path: string; title: string } | undefined) =>
      listener(project),
    )
  },
  listDirectory: (root: string, relative: string) => ipcRenderer.invoke('pane:list-directory', root, relative),
  onProjectChanged: (listener: (root: string, relative: string) => void) => {
    ipcRenderer.on('pane:project-changed', (_event, root: string, relative: string) => listener(root, relative))
  },
  openFile: (root: string, relative: string) => ipcRenderer.send('pane:open-file', root, relative),
  createFile: (root: string, relative: string) => ipcRenderer.invoke('pane:create-file', root, relative),
  createFolder: (root: string, relative: string) => ipcRenderer.invoke('pane:create-folder', root, relative),
  treeMenu: (target: { directory: boolean; pending: boolean; name: string }) =>
    ipcRenderer.invoke('pane:tree-menu', target),
  renameEntry: (root: string, relative: string, name: string) =>
    ipcRenderer.invoke('pane:rename-entry', root, relative, name),
  deleteEntry: (root: string, relative: string, directory: boolean) =>
    ipcRenderer.invoke('pane:delete-entry', root, relative, directory),
  pasteEntry: (root: string, relative: string, into: string, move: boolean) =>
    ipcRenderer.invoke('pane:paste-entry', root, relative, into, move),
  openInWeb: (root: string, relative: string) => ipcRenderer.send('pane:open-in-web', root, relative),
  loadInWeb: (root: string, relative: string) => ipcRenderer.send('pane:load-in-web', root, relative),
  onSaveForWeb: (listener: (root: string, relative: string) => void) => {
    ipcRenderer.on('pane:save-for-web', (_event, root: string, relative: string) => listener(root, relative))
  },
  revealEntry: (root: string, relative: string) => ipcRenderer.send('pane:reveal-entry', root, relative),
  copyPath: (root: string, relative: string) => ipcRenderer.send('pane:copy-path', root, relative),
  addToChat: (root: string, relative: string, directory: boolean) =>
    ipcRenderer.send('pane:add-to-chat', root, relative, directory),
  closeEditor: () => ipcRenderer.send('pane:close-editor'),
  openExternal: (url: string) => ipcRenderer.send('pane:open-external', url),
  readFile: (root: string, relative: string) => ipcRenderer.invoke('pane:read-file', root, relative),
  writeFile: (root: string, relative: string, text: string) =>
    ipcRenderer.invoke('pane:write-file', root, relative, text),
  onOpenFile: (listener: (root: string, relative: string, url: string) => void) => {
    ipcRenderer.on('pane:open', (_event, root: string, relative: string, url: string) =>
      listener(root, relative, url),
    )
  },
  onFileChanged: (listener: (root: string, relative: string) => void) => {
    ipcRenderer.on('pane:file-changed', (_event, root: string, relative: string) => listener(root, relative))
  },
  navigate: (url: string) => ipcRenderer.send('pane:navigate', url),
  webBack: () => ipcRenderer.send('pane:web-back'),
  webForward: () => ipcRenderer.send('pane:web-forward'),
  webReload: () => ipcRenderer.send('pane:web-reload'),
  onWebState: (listener: (state: { url: string; canGoBack: boolean; canGoForward: boolean }) => void) => {
    ipcRenderer.on('pane:web-state', (_event, state: { url: string; canGoBack: boolean; canGoForward: boolean }) =>
      listener(state),
    )
  },
  onShowWeb: (listener: () => void) => {
    ipcRenderer.on('pane:show-web', () => listener())
  },
  // The git panel's three channels. The read is an invoke because the panel
  // waits on it; the change notice is a push because only main knows when a
  // watcher fired; the diff is a send because the editor column is main's to
  // fill and there is no answer to wait for.
  readGit: () => ipcRenderer.invoke('git:read'),
  onGitChanged: (listener: () => void) => {
    ipcRenderer.on('git:changed', () => listener())
  },
  openGitDiff: (repo: string, path: string, section: string) =>
    ipcRenderer.send('git:open-diff', repo, path, section),
  onShowDiff: (listener: (root: string, relative: string, proposed: string) => void) => {
    ipcRenderer.on('pane:diff', (_event, root: string, relative: string, proposed: string) =>
      listener(root, relative, proposed),
    )
  },
})
