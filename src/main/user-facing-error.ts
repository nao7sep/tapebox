import type { IpcFailureCode } from '@shared/ipc-reply'
import { createTranslator, type Message } from '@shared/i18n/translate'

/**
 * A failure whose message main deliberately wrote for the user: a refusal, an
 * unusable input, an on-disk conflict, or a provider's own reason. The IPC
 * boundary (ipc/handle.ts) passes its message through as presentation copy; any
 * other thrown value collapses to the renderer's operation-specific copy.
 *
 * Throw it only with copy that names no internal path, type or implementation
 * detail (error-handling-conventions); a user-chosen file or folder may be named.
 * The copy is a message descriptor, rendered in the window's language; its
 * English text is this error's own message, for the log.
 */
export class UserFacingError extends Error {
  constructor(
    readonly code: Exclude<IpcFailureCode, 'internal'>,
    readonly userMessage: Message,
    options?: ErrorOptions,
  ) {
    super(ENGLISH.text(userMessage), options)
    this.name = 'UserFacingError'
  }
}

const ENGLISH = createTranslator('en')
