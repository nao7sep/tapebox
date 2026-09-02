import { log } from '@renderer/ipc/log'
import { describeError } from '@shared/error'

/** Preserve diagnostics in the session log and return stable operation copy. */
export function presentFailure(error: unknown, userMessage: string, operation: string) {
  log.error(operation, { error: describeError(error) })
  return userMessage
}
