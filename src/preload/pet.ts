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
})
