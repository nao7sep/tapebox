import { watch } from 'node:fs'

/** Await a fixture's filesystem evidence. The test harness signal owns the
 * deadline; process scheduling is not a product latency assertion. */
export function waitForFixture<T>(directory: string, read: () => T | undefined, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, check)
    function cleanup() {
      watcher.close()
      signal.removeEventListener('abort', onAbort)
    }
    function fail(error: unknown) { cleanup(); reject(error) }
    function onAbort() { fail(signal.reason) }
    function check() {
      try {
        const value = read()
        if (value !== undefined) { cleanup(); resolve(value) }
      } catch (error) {
        // A fixture may not have created its readiness file yet.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(error)
      }
    }
    watcher.once('error', fail)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else check() // Watching first also covers creation before this initial read.
  })
}
