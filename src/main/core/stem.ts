import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { portableFilenameIdentity } from '@shared/filename'

/**
 * Reserve an unused id for a new tape. The id names the tape's folder in the
 * library and the stem of its downloaded files, so the on-disk names are opaque,
 * stable and unique by construction. A nanoid collision is astronomically
 * unlikely, but checking makes reuse impossible rather than merely improbable:
 * an id another catalog row holds in any case, or whose folder is already there
 * (a tape removed with "keep files"), is passed over.
 */

const ID_LENGTH = 10

export async function reserveTapeId(libraryDir: string, taken: Iterable<string>): Promise<string> {
  const held = new Set([...taken].map(portableFilenameIdentity))
  for (;;) {
    const id = nanoid(ID_LENGTH)
    if (held.has(portableFilenameIdentity(id))) continue
    if (!(await exists(join(libraryDir, id)))) return id
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}
