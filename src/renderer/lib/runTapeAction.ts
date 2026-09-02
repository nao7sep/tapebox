import { presentFailure } from '@renderer/lib/presentFailure'
import {
  type TapeAction,
  useTapeActionResultsStore,
} from '@renderer/store/tapeActionResults'

const attempts = new Map<string, number>()

export type TapeActionOutcome = 'succeeded' | 'failed' | 'superseded'

/** Settle one immediate tape command at the tape that owns its consequence. */
export async function runTapeAction(
  tapeId: string,
  action: TapeAction,
  operation: string,
  userMessage: string,
  invoke: () => Promise<unknown>,
): Promise<TapeActionOutcome> {
  const attemptKey = `${tapeId}:${action}`
  const attempt = (attempts.get(attemptKey) ?? 0) + 1
  attempts.set(attemptKey, attempt)
  const results = useTapeActionResultsStore.getState()
  results.setResult(tapeId, action, null)
  try {
    await invoke()
    return attempts.get(attemptKey) === attempt ? 'succeeded' : 'superseded'
  } catch (error) {
    const message = presentFailure(error, userMessage, operation)
    // A later attempt for this same tape/action owns both presentation and any
    // optimistic rollback. Its outcome must not be overwritten by this one,
    // while the stale failure still remains in diagnostics.
    if (attempts.get(attemptKey) !== attempt) return 'superseded'
    useTapeActionResultsStore.getState().setResult(
      tapeId,
      action,
      message,
    )
    return 'failed'
  }
}
