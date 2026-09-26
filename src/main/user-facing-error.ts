import type { IpcFailureCode } from '@shared/ipc-reply'

/**
 * A failure whose message main deliberately wrote for the user: a refusal, an
 * unusable input, an on-disk conflict, or a provider's own reason. The IPC
 * boundary (ipc/handle.ts) passes its message through as presentation copy; any
 * other thrown value collapses to the renderer's operation-specific copy.
 *
 * Throw it only with copy that names no internal path, type or implementation
 * detail (error-handling-conventions); a user-chosen file or folder may be named.
 */
export class UserFacingError extends Error {
  constructor(
    readonly code: Exclude<IpcFailureCode, 'internal'>,
    userMessage: string,
    options?: ErrorOptions,
  ) {
    super(userMessage, options)
    this.name = 'UserFacingError'
  }
}
