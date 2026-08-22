import { ipcMain } from 'electron'
import { z } from 'zod'
import type { IpcCalls } from '@shared/ipc-contract'
import { describeError, errorMessage } from '@shared/error'
import { log } from '@main/io/logger'
import { ipcRequestSchemas } from './schemas'

/**
 * Typed wrapper around ipcMain.handle.
 *
 * Every request is first validated against the channel's runtime schema (see
 * schemas.ts) — the type-only IpcCalls contract checks the wire shape at compile
 * time, but this is the boundary where a malformed payload from a compromised
 * renderer is actually rejected before it reaches privileged code. A rejected
 * request and a thrown handler are logged distinctly, then re-thrown so the
 * renderer's invoke promise rejects with a meaningful message.
 */
export function handle<K extends keyof IpcCalls>(
  channel: K,
  handler: (req: IpcCalls[K]['req']) => IpcCalls[K]['res'] | Promise<IpcCalls[K]['res']>,
): void {
  // Indexed by a generic K, the map's value widens to a union; the cast re-pins it
  // to this channel's schema, which the `satisfies` clause in schemas.ts guarantees
  // outputs exactly IpcCalls[K]['req'].
  const schema = ipcRequestSchemas[channel] as z.ZodType<IpcCalls[K]['req']>
  ipcMain.handle(channel, async (_event, rawReq: unknown) => {
    let req: IpcCalls[K]['req']
    try {
      req = schema.parse(rawReq)
    } catch (err) {
      log.error('ipc request rejected', { channel, error: describeError(err) })
      throw err
    }
    try {
      return await handler(req)
    } catch (err) {
      log.error('ipc handler failed', { channel, error: describeError(err) })
      const visibleMessage = errorMessage(err)
      if (err instanceof Error && visibleMessage !== err.message) {
        throw new Error(visibleMessage, { cause: err })
      }
      throw err
    }
  })
}
