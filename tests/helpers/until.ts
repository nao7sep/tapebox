// Captured before any test fakes the clock, so waiting never depends on it.
const nextTurn = globalThis.setImmediate

/** Resolves once `assertion` passes, trying it first and again after each turn
 * of the event loop, like vi.waitFor without its deadline: a wait that never
 * ends is a hang to diagnose (tests-folder-conventions). */
export async function until(assertion: () => unknown): Promise<void> {
  for (;;) {
    try {
      await assertion()
      return
    } catch {
      await new Promise<void>((resolve) => nextTurn(resolve))
    }
  }
}
