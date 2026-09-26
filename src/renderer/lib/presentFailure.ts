import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'
import { IpcCallError } from '@shared/ipc-reply'

/**
 * Preserve diagnostics in the session log and return the copy to show: the
 * message main authored for the user when the failure carries one, else the
 * caller's stable operation copy. No other error text ever reaches a surface.
 */
export function presentFailure(error: unknown, userMessage: string, operation: string) {
  log.error(operation, { error: describeError(error) })
  if (error instanceof IpcCallError && error.userMessage !== null) return error.userMessage
  return userMessage
}
