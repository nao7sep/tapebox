import { BrowserWindow } from 'electron'
import type { IpcEvents } from '@shared/ipc-contract'

/** Push an event to one window's renderer, typed like {@link emit}. */
export function sendTo<K extends keyof IpcEvents>(contents: Electron.WebContents, channel: K, payload: IpcEvents[K]): void {
  if (!contents.isDestroyed()) contents.send(channel, payload)
}

/**
 * Push an event to every live renderer.
 * Events fired before any window exists are dropped: a window's
 * collection:subscribe sends it the session as it is then.
 */
export function emit<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
