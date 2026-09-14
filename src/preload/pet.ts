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
type PetDriveState = 'idle' | 'running' | 'waiting' | 'wave'

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
  onState: (cb: (snap: { state: PetDriveState; badge: boolean }) => void) =>
    ipcRenderer.on('pet:state', (_e, snap: { state: PetDriveState; badge: boolean }) => cb(snap)),
  onTheme: (cb: (dark: boolean) => void) => ipcRenderer.on('theme', (_e, dark: boolean) => cb(dark)),
  activate: () => ipcRenderer.send('pet:activate'),
  menu: () => ipcRenderer.send('pet:menu'),
})
