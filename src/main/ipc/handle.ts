import { ipcMain } from 'electron'
import { z } from 'zod'
import type { IpcCalls } from '@shared/ipc-contract'
import { describeError } from '@shared/error'
import { log } from '@main/io/logger'
import { ipcRequestSchemas } from './schemas'

/**
 * Typed wrapper around ipcMain.handle.
 *
 * Every request is first validated against the channel's runtime schema (see
 * schemas.ts) — the type-only IpcCalls contract checks the wire shape at compile
 * time, but this is the boundary where a malformed payload from a compromised
 * renderer is actually rejected before it reaches privileged code. A rejected
 * request and a thrown handler are logged distinctly. Only stable app-authored
 * copy crosses back to the renderer; full exception diagnostics stay in main's
 * structured log.
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
      throw new Error('The request could not be completed.', { cause: err })
    }
    try {
      return await handler(req)
    } catch (err) {
      log.error('ipc handler failed', { channel, error: describeError(err) })
      throw new Error('The operation could not be completed.', { cause: err })
    }
  })
}
