import { ipcMain } from 'electron'
import { z } from 'zod'
import type { IpcCalls } from '@shared/ipc-contract'
import type { IpcReply } from '@shared/ipc-reply'
import { describeError } from '@shared/error'
import { log } from '@main/io/logger'
import { UserFacingError } from '@main/user-facing-error'
import { ipcRequestSchemas } from './schemas'

/**
 * Typed wrapper around ipcMain.handle.
 *
 * Every request is first validated against the channel's runtime schema (see
 * schemas.ts) — the type-only IpcCalls contract checks the wire shape at compile
 * time, but this is the boundary where a malformed payload from a compromised
 * renderer is actually rejected before it reaches privileged code. A rejected
 * request and a thrown handler are logged distinctly.
 *
 * Every call resolves with an {@link IpcReply}. A {@link UserFacingError} crosses
 * as its code and authored message; any other failure crosses as `internal` with
 * no message, and its full diagnostics stay in main's structured log.
 */
export function handle<K extends keyof IpcCalls>(
  channel: K,
  handler: (req: IpcCalls[K]['req']) => IpcCalls[K]['res'] | Promise<IpcCalls[K]['res']>,
): void {
  // Indexed by a generic K, the map's value widens to a union; the cast re-pins it
  // to this channel's schema, which the `satisfies` clause in schemas.ts guarantees
  // outputs exactly IpcCalls[K]['req'].
  const schema = ipcRequestSchemas[channel] as z.ZodType<IpcCalls[K]['req']>
  ipcMain.handle(channel, async (_event, rawReq: unknown): Promise<IpcReply<IpcCalls[K]['res']>> => {
    let req: IpcCalls[K]['req']
    try {
      req = schema.parse(rawReq)
    } catch (err) {
      log.error('ipc request rejected', { channel, error: describeError(err) })
      return { ok: false, failure: { code: 'internal', userMessage: null } }
    }
    try {
      return { ok: true, value: await handler(req) }
    } catch (err) {
      if (err instanceof UserFacingError) {
        log.warn('ipc handler refused', { channel, error: describeError(err) })
        return { ok: false, failure: { code: err.code, userMessage: err.message } }
      }
      log.error('ipc handler failed', { channel, error: describeError(err) })
      return { ok: false, failure: { code: 'internal', userMessage: null } }
    }
  })
}
