import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { portableFilenameIdentity } from '@shared/filename'

export type PortableDirectoryEntry = { name: string; identity: string }
export type AllowedPortableDirectoryEntry = { name: string; identity: string }

/** Decide whether matching directory entries include anything beyond the exact
 * name+physical claims owned by the current transaction. Each portable-equivalent
 * name and inode pair exempts at most one entry, so a second case/NFC alias (even
 * a cross-member hard link to the same inode) cannot hide behind another member's
 * claim or an identity-wide ignore set. */
export function hasPortableEntryCollision(
  targetName: string,
  entries: readonly PortableDirectoryEntry[],
  allowedEntries: readonly AllowedPortableDirectoryEntry[] = [],
): boolean {
  const targetIdentity = portableFilenameIdentity(targetName)
  const remaining = allowedEntries
    .filter((entry) => portableFilenameIdentity(entry.name) === targetIdentity)
    .map((entry) => entry.identity)
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
  allowedEntries: readonly AllowedPortableDirectoryEntry[] = [],
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
  return hasPortableEntryCollision(basename(path), entries, allowedEntries)
}
