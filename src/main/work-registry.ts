/**
 * The owner of cancellable, user-started work outside the download queue and the
 * page scans: AI name suggestions, renames, exports, imports, metadata refreshes
 * and library moves. Each run gets its own AbortSignal. A caller-supplied key lets
 * the renderer cancel one run (e.g. the Suggest button); quitting cancels every
 * run and waits for each to settle, so no child process or half-written library
 * file outlives the app.
 */

type Run = { controller: AbortController; settled: Promise<void> }

const runs = new Set<Run>()
const byKey = new Map<string, Run>()
let closed = false

export class WorkClosedError extends Error {
  constructor() {
    super('TapeBox is quitting.')
    this.name = 'WorkClosedError'
  }
}

/** Run `work` with a signal that aborts on {@link cancelWork}(key) or at quit. */
export function runCancellable<T>(work: (signal: AbortSignal) => Promise<T>, key?: string): Promise<T> {
  if (closed) return Promise.reject(new WorkClosedError())
  const controller = new AbortController()
  let promise: Promise<T>
  try {
    promise = work(controller.signal)
  } catch (error) {
    promise = Promise.reject(error)
  }
  const run: Run = { controller, settled: promise.then(() => {}, () => {}) }
  runs.add(run)
  if (key !== undefined) byKey.set(key, run)
  void run.settled.then(() => {
    runs.delete(run)
    if (key !== undefined && byKey.get(key) === run) byKey.delete(key)
  })
  return promise
}

/** Abort the run registered under `key`, if it is still in flight. */
export function cancelWork(key: string): void {
  byKey.get(key)?.controller.abort()
}

/** Refuse new runs, abort every run in flight, and wait until each has settled. */
export async function cancelAllWork(): Promise<void> {
  closed = true
  const pending = [...runs]
  for (const run of pending) run.controller.abort()
  await Promise.all(pending.map((run) => run.settled))
}
