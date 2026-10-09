import { readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { portableFilenameIdentity } from '@shared/filename'

/**
 * True if `path`'s directory already holds an entry with the same portable
 * filename identity: NFC-normalized and lowercased. These aliases collide on
 * macOS and Windows even when an exact `stat(path)` reports the requested
 * spelling missing, and a case-sensitive volume would otherwise let two names
 * that collide elsewhere sit side by side (storage-path-conventions). A missing
 * directory means no sibling.
 */
export async function portableSiblingExists(path: string): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dirname(path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  const targetIdentity = portableFilenameIdentity(basename(path))
  return names.some((name) => portableFilenameIdentity(name) === targetIdentity)
}
