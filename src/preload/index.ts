import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

/**
 * Minimal, generic bridge. The renderer wraps these in typed helpers
 * (renderer/ipc/client.ts) derived from src/shared/ipc-contract.ts.
 *
 * We intentionally do NOT expose ipcRenderer directly across the bridge —
 * only the two operations we need: invoke (request/response) and on (events).
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
}

contextBridge.exposeInMainWorld('tapebox', api)
