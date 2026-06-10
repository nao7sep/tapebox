import { ipcMain } from 'electron'
import type { IpcCalls } from '@shared/ipc-contract'
import { describeError } from '@shared/error'
import { log } from '@main/io/logger'

/**
 * Typed wrapper around ipcMain.handle.
 * Handler errors are logged and re-thrown so the renderer's invoke promise
 * rejects with a meaningful message.
 */
export function handle<K extends keyof IpcCalls>(
  channel: K,
  handler: (req: IpcCalls[K]['req']) => IpcCalls[K]['res'] | Promise<IpcCalls[K]['res']>,
): void {
  ipcMain.handle(channel, async (_event, req: IpcCalls[K]['req']) => {
    try {
      return await handler(req)
    } catch (err) {
      log.error('ipc handler failed', { channel, error: describeError(err) })
      throw err
    }
  })
}
