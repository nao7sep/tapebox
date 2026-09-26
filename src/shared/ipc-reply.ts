/**
 * The wire shape every IPC call settles with, and its one unwrapping point.
 *
 * Electron transfers only a rejected handler's message string, wrapped in its own
 * "Error invoking remote method" prose, so a thrown error cannot carry structured
 * failure data across the boundary. Handlers therefore always resolve with a
 * reply: the value, or a failure whose fields separate a stable code from the
 * presentation copy main authored for the user. Diagnostics never cross; main's
 * handle() logs them.
 *
 * Pure and node-free, so main (handle), the renderer (ipc/client) and tests share
 * the one definition.
 */

/**
 * Why a call failed, where the difference matters to the user:
 * - refused: the app declined the request in its current state (work in flight,
 *   an item already present); the copy says what to do first.
 * - invalid: the request's own input is unusable; the copy says what to fix.
 * - conflict: something on disk is in the way; the copy names it.
 * - provider: a third-party service answered with an error; the copy carries its reason.
 * - internal: anything else. No copy crosses; the renderer shows its operation's own.
 */
export type IpcFailureCode = 'refused' | 'invalid' | 'conflict' | 'provider' | 'internal'

export type IpcFailure =
  | { code: Exclude<IpcFailureCode, 'internal'>; userMessage: string }
  | { code: 'internal'; userMessage: null }

export type IpcReply<T> = { ok: true; value: T } | { ok: false; failure: IpcFailure }

/** Stable copy for a failure that carries none of its own. */
export const INTERNAL_FAILURE_MESSAGE = 'The operation could not be completed.'

/**
 * A failed IPC call as the caller sees it. `userMessage` is present only when main
 * deliberately authored it for the user, which is the one field a surface may show.
 */
export class IpcCallError extends Error {
  readonly code: IpcFailureCode
  readonly userMessage: string | null

  constructor(readonly channel: string, failure: IpcFailure) {
    super(failure.userMessage ?? INTERNAL_FAILURE_MESSAGE)
    this.name = 'IpcCallError'
    this.code = failure.code
    this.userMessage = failure.userMessage
  }
}

/** The value of a successful reply; a failed one throws its {@link IpcCallError}. */
export function unwrapIpcReply<T>(channel: string, reply: IpcReply<T>): T {
  if (reply.ok) return reply.value
  throw new IpcCallError(channel, reply.failure)
}
