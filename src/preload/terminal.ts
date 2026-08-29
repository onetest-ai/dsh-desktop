import { contextBridge, ipcRenderer } from 'electron'

/**
 * What the terminal panel may ask of main.
 *
 * The page never names a shell, a directory, or a session it did not start:
 * `start` takes only a size, and main decides what runs and where. Everything
 * else is addressed by the id main handed back, which main checks against the
 * terminals it actually started.
 */
contextBridge.exposeInMainWorld('terminal', {
  start: (cols: number, rows: number) => ipcRenderer.invoke('terminal:start', cols, rows),
  input: (id: number, data: string) => ipcRenderer.send('terminal:input', id, data),
  resize: (id: number, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
  ack: (id: number, chars: number) => ipcRenderer.send('terminal:ack', id, chars),
  kill: (id: number) => ipcRenderer.send('terminal:kill', id),
  closePanel: () => ipcRenderer.send('terminal:close-panel'),
  onData: (listener: (id: number, data: string) => void) => {
    ipcRenderer.on('terminal:data', (_event, id: number, data: string) => listener(id, data))
  },
  onExit: (listener: (id: number, code: number) => void) => {
    ipcRenderer.on('terminal:exit', (_event, id: number, code: number) => listener(id, code))
  },
  onFailed: (listener: (id: number, reason: string) => void) => {
    ipcRenderer.on('terminal:failed', (_event, id: number, reason: string) => listener(id, reason))
  },
  onShown: (listener: () => void) => {
    ipcRenderer.on('terminal:shown', () => {
      listener()
    })
  },
  askTheme: () => ipcRenderer.send('theme:ask'),
  onTheme: (listener: (dark: boolean) => void) => {
    ipcRenderer.on('theme', (_event, dark: boolean) => listener(dark))
  },
})
