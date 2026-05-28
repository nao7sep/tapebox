import { BrowserWindow } from 'electron'
import type { IpcEvents } from '@shared/ipc-contract'

/**
 * Push an event to every live renderer.
 * Events fired before any window exists are silently dropped — that's fine
 * for now: the renderer's initial library:list fetch picks up missed state.
 */
export function emit<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
