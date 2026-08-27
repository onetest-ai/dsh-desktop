import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The startup surface's entire capability surface.
 *
 * Two operations reach the main process and three are receive-only. The
 * renderer cannot read the config, run a check, or install anything: it is
 * told what was found and what phase is current, and can ask only for the two
 * things a stuck user needs — open Settings, or start anyway. Every decision
 * stays in main, which is what lets this page also be the failure screen.
 */
contextBridge.exposeInMainWorld('startup', {
  openSettings: () => ipcRenderer.invoke('startup:open-settings'),
  continueAnyway: () => ipcRenderer.invoke('startup:continue-anyway'),
  onFindings: (listener: (findings: unknown[]) => void) => {
    const handler = (_event: IpcRendererEvent, findings: unknown[]): void => listener(findings)
    ipcRenderer.on('startup:findings', handler)
    return () => ipcRenderer.removeListener('startup:findings', handler)
  },
  onPhase: (listener: (phase: string) => void) => {
    const handler = (_event: IpcRendererEvent, phase: string): void => listener(phase)
    ipcRenderer.on('startup:phase', handler)
    return () => ipcRenderer.removeListener('startup:phase', handler)
  },
  onProgress: (listener: (line: string) => void) => {
    const handler = (_event: IpcRendererEvent, line: string): void => listener(line)
    ipcRenderer.on('startup:progress', handler)
    return () => ipcRenderer.removeListener('startup:progress', handler)
  },
})
