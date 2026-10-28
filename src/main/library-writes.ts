import { getLibraryDir } from '@main/store/config'

/**
 * The one owner of file actions in the library folder. Import, rename, Apply's
 * poster and sidecar, export, removal, a library move and a finished download's
 * step into the library each take a turn and run one at a time, in arrival
 * order; an action that waits shows as in progress until its turn has run
 * (developer decision). Downloads themselves run side by side outside turns,
 * each in its own tape's file namespace.
 *
 * A move runs in its turn with `moving` set, so the queue starts no download
 * until it ends; its caller refuses the move while a download runs.
 */

let turns: Promise<unknown> = Promise.resolve()
let moving = false

/** Run `work` at its turn, with the library folder resolved when the turn starts. */
export function withLibraryTurn<T>(work: (libraryDir: string) => Promise<T>): Promise<T> {
  const run = turns.then(() => work(getLibraryDir()))
  turns = run.catch(() => {})
  return run
}

/** Run a library move at its turn, holding off new downloads until it settles. */
export function withLibraryMove<T>(work: () => Promise<T>): Promise<T> {
  return withLibraryTurn(async () => {
    moving = true
    try {
      return await work()
    } finally {
      moving = false
    }
  })
}

export function isLibraryMoving(): boolean {
  return moving
}
