import { contextBridge, ipcRenderer } from 'electron'

/**
 * A compose request forwarded from the pet's mini-composer, and the
 * workspace/model choices the harness page reports back so that composer
 * can offer them instead of a bare text box. Re-declared here rather than
 * imported: this file compiles under the main tsconfig alongside `src/main`,
 * but the desktop plugin (outside this compile) and `src/main/index.ts`
 * each keep their own copy of the same shape by hand.
 */
interface ComposeRequest {
  text: string
  workspaceId?: string
  model?: string
  send: boolean
}
interface ComposerOptions {
  workspaces: { id: string; title: string; current: boolean }[]
  models?: { id: string; label: string; current: boolean }[]
}

/**
 * What the harness page is told by this app, and what it can tell this app
 * back.
 *
 * Three inbound calls: two about which project is in front of the user (a
 * path picked in this app's file tree, and the directory the open session
 * works in), and one delivering a compose request typed into the floating
 * pet. One outbound call reports the workspaces (and, where reachable,
 * models) the page currently offers, so the pet's composer can show real
 * choices instead of guessing. The page cannot toggle a column or read a
 * file through this — the controls for that are this app's own, on its rail
 * — and the harness page hosts other packages' browser halves, so what it
 * can reach stays this narrow.
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
  onCompose: (listener: (req: ComposeRequest) => void) => {
    ipcRenderer.on('harness:compose', (_event, req: ComposeRequest) => listener(req))
  },
  reportComposerOptions: (opts: ComposerOptions) => ipcRenderer.send('harness:composer-options', opts),
})
