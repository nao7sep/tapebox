import { stat } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { portableFilenameIdentity } from '@shared/filename'
import { tapeDir } from '@main/paths'

/**
 * Reserve an unused id for a new tape. The id names the tape's folder in the
 * collection and the stem of its downloaded files, so the on-disk names are opaque,
 * stable and unique by construction. A nanoid collision is astronomically
 * unlikely, but checking makes reuse impossible rather than merely improbable:
 * an id another tape holds in any case, or whose folder is already in the Inbox
 * or on the Shelf (a tape removed with "keep files"), is passed over.
 */

const ID_LENGTH = 10

export async function reserveTapeId(collectionDir: string, taken: Iterable<string>): Promise<string> {
  const held = new Set([...taken].map(portableFilenameIdentity))
  for (;;) {
    const id = nanoid(ID_LENGTH)
    if (held.has(portableFilenameIdentity(id))) continue
    const folders = [false, true].map((shelved) => tapeDir(collectionDir, { id, shelved }))
    if (!(await exists(folders[0]!)) && !(await exists(folders[1]!))) return id
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
