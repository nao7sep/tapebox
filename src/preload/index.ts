import { contextBridge } from 'electron'

/**
 * Preload script — the only thing the renderer can see from Node.
 *
 * In the next phase this exposes a typed API surface backed by ipcRenderer
 * (invoke + on), derived from src/shared/ipc-contract.ts. For now it's a
 * placeholder so the scaffold runs.
 */
contextBridge.exposeInMainWorld('tapebox', {
  ping: (): string => 'pong',
})
