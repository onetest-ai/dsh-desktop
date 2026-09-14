import { contextBridge, ipcRenderer } from 'electron'

/**
 * The subset of states the main-process pet state machine drives.
 *
 * Re-declared rather than imported from `src/renderer/pane/pet-layout.ts`:
 * the preload compiles under the main tsconfig, which excludes the pane
 * directory, and the renderer/main boundary this app enforces runs both
 * ways — nothing on either side of it reaches across for a type. Keep this
 * identical to `PetDriveState` there by hand.
 */
type PetDriveState = 'idle' | 'running' | 'waiting' | 'wave' | 'jumping' | 'failed' | 'review'

/**
 * The rich compose round trip, re-declared for the same reason as
 * `PetDriveState` above: `src/preload/harness.ts` and `src/main/index.ts`
 * each keep their own identical copy. `ComposeRequest` travels pet → main →
 * harness page unchanged; `ComposerOptions` travels the harness page → main
 * → pet.
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
 * What the pet window may ask of main, and what main pushes into it.
 *
 * Unlike the pane bridge, this window never touches the filesystem or the
 * open project at all — it only paints sprites main sends and reports back
 * a double-click (bring the app to front) or a right-click (its menu).
 */
contextBridge.exposeInMainWorld('pet', {
  onSprite: (cb: (dataUrl: string, scale: number) => void) =>
    ipcRenderer.on('pet:sprite', (_e, dataUrl: string, scale: number) => cb(dataUrl, scale)),
  onState: (cb: (snap: { state: PetDriveState; badge: boolean; text?: string }) => void) =>
    ipcRenderer.on('pet:state', (_e, snap: { state: PetDriveState; badge: boolean; text?: string }) => cb(snap)),
  onTheme: (cb: (dark: boolean) => void) => ipcRenderer.on('theme', (_e, dark: boolean) => cb(dark)),
  activate: () => ipcRenderer.send('pet:activate'),
  menu: () => ipcRenderer.send('pet:menu'),
  // Click-to-compose: the quick message typed into the pet is forwarded to
  // main, which types it into the harness chat composer and sends it. The text
  // is data only — main routes it through `webContents.insertText`, never into
  // an injected-JS string.
  compose: (text: string) => ipcRenderer.send('pet:compose', text),
  // The rich path: the harness page's reported workspace/model choices come
  // in through `onComposerOptions`, and a full `ComposeRequest` (project,
  // model, queue-vs-send) goes out through `composeRich` instead of the
  // plain-text `compose` above. Both are unused until the composer UI and
  // the plugin's browser half exist — this only opens the channel.
  onComposerOptions: (cb: (opts: ComposerOptions) => void) =>
    ipcRenderer.on('pet:composer-options', (_e, opts: ComposerOptions) => cb(opts)),
  composeRich: (req: ComposeRequest) => ipcRenderer.send('pet:compose-rich', req),
  // The rich panel (text + project + send) needs more room above the sprite
  // than the one-line fallback input does. Rather than have the renderer
  // guess at window bounds it cannot see, it just tells main when the panel
  // opens and closes; main resizes the frameless window and restores it —
  // see `petComposePanelSize` in `src/main/pet-window.ts`.
  setComposeOpen: (open: boolean) => ipcRenderer.send('pet:compose-open', open),
})
