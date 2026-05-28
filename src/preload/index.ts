import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'

/**
 * Generic bridge. The renderer wraps these in typed helpers
 * (renderer/ipc/client.ts) derived from src/shared/ipc-contract.ts.
 *
 * pathForFile is the Electron 32+ replacement for File.path — required to
 * extract a real filesystem path from a dragged File object.
 */
const api = {
  invoke(channel: string, req: unknown): Promise<unknown> {
    return ipcRenderer.invoke(channel, req)
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  },
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
}

contextBridge.exposeInMainWorld('tapebox', api)
