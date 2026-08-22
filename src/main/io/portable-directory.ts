import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileClaim } from './atomic-file'
import { portableFilenameIdentity } from '@shared/filename'

export type PortableDirectoryEntry = { name: string; identity: string }

/** Decide whether matching directory entries include anything beyond the exact
 * physical claims owned by the current transaction. Each claim exempts at most
 * one entry, so a second case/NFC alias (even a hard link to the same inode) is a
 * collision rather than being hidden by an identity-wide ignore set. */
export function hasPortableEntryCollision(
  targetName: string,
  entries: readonly PortableDirectoryEntry[],
  allowedClaims: readonly Pick<FileClaim, 'identity'>[] = [],
): boolean {
  const targetIdentity = portableFilenameIdentity(targetName)
  const remaining = allowedClaims.map((claim) => claim.identity)
  for (const entry of entries) {
    if (portableFilenameIdentity(entry.name) !== targetIdentity) continue
    const owned = remaining.indexOf(entry.identity)
    if (owned >= 0) {
      remaining.splice(owned, 1)
      continue
    }
    return true
  }
  return false
}

/** Enumerate actual sibling entries by portable identity. Owned physical claims
 * may be allowed (for an equivalent-name rename); unrelated aliases never are. */
export async function portableSiblingExists(
  path: string,
  allowedClaims: readonly FileClaim[] = [],
): Promise<boolean> {
  const directory = dirname(path)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }

  const targetIdentity = portableFilenameIdentity(basename(path))
  const entries: PortableDirectoryEntry[] = []
  for (const name of names) {
    if (portableFilenameIdentity(name) !== targetIdentity) continue
    try {
      const value = await lstat(join(directory, name), { bigint: true })
      entries.push({ name, identity: `${value.dev}:${value.ino}` })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return hasPortableEntryCollision(basename(path), entries, allowedClaims)
}
