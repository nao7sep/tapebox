import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import type { LogMessage } from '@shared/log'

/**
 * Generic bridge. The renderer wraps these in typed helpers
 * (renderer/ipc/client.ts) derived from src/shared/ipc-contract.ts.
 *
 * pathForFile is the Electron 32+ replacement for File.path — required to
 * extract a real filesystem path from a dragged File object.
 *
 * log forwards a structured log object to the main process (which owns the
 * session file) one-way — the sandboxed renderer never opens the file itself.
 *
 * isDebugEnabled is main's debug state, read once synchronously at preload time
 * (main registers its IPC handlers before the window loads), so the renderer can
 * skip forwarding debug lines a packaged release would only drop. `=== true`
 * keeps it fail-open: an undefined reply leaves debug forwarding on.
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
  log(message: LogMessage): void {
    ipcRenderer.send('log:write', message)
  },
  isDebugEnabled: ipcRenderer.sendSync('log:debug-enabled') !== false,
}

contextBridge.exposeInMainWorld('tapebox', api)
