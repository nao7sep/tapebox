import { getLibraryDir } from '@main/store/config'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'

/**
 * The one owner of writes into the library folder. Every run that creates,
 * rewrites or removes library files — a download job, an import, a rename, an
 * export (which may remove the originals), a metadata refresh that saves a poster,
 * a removal — holds a write claim for its whole run and resolves the library
 * folder under it. A library move runs only while no claim is held and blocks new
 * claims until it has committed or rolled back, so no file lands in, or leaves, the
 * old folder while its contents are being moved.
 *
 * A move refuses rather than waits: the user finishes or stops the work first. A
 * write started during a move is refused too, except downloads, which the queue
 * simply does not start until the move ends.
 */

let writers = 0
let moving = false

const MOVE_BLOCKED_MESSAGE = message('errors.libraryMoveBlocked')
const WRITE_BLOCKED_MESSAGE = message('errors.libraryWriteBlocked')

/**
 * Claim a write, or get null while a move runs. The returned release is
 * idempotent; the caller calls it once the run has settled.
 */
export function tryClaimLibraryWrite(): (() => void) | null {
  if (moving) return null
  writers += 1
  let released = false
  return () => {
    if (released) return
    released = true
    writers -= 1
  }
}

/** Run `work` under a write claim, with the library folder resolved inside it. */
export async function withLibraryWrite<T>(work: (libraryDir: string) => Promise<T>): Promise<T> {
  const release = tryClaimLibraryWrite()
  if (!release) throw new UserFacingError('refused', WRITE_BLOCKED_MESSAGE)
  try {
    return await work(getLibraryDir())
  } finally {
    release()
  }
}

/** Run a library move once no write is in flight, holding off every new write until it settles. */
export async function withLibraryMove<T>(work: () => Promise<T>): Promise<T> {
  if (moving) throw new UserFacingError('refused', WRITE_BLOCKED_MESSAGE)
  if (writers > 0) throw new UserFacingError('refused', MOVE_BLOCKED_MESSAGE)
  moving = true
  try {
    return await work()
  } finally {
    moving = false
  }
}

export function isLibraryMoving(): boolean {
  return moving
}
