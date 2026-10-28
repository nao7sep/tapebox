import { resolve } from 'node:path'
import { TRACKED_FILENAME_FIELDS, type Tape } from '@shared/domain'
import { portableFilenameIdentity } from '@shared/filename'

type Namespace = { names?: readonly string[]; stems?: readonly string[] }
type Counts = { names: Map<string, number>; stems: Map<string, number> }
const directories = new Map<string, Counts>()

/** The provider and removal own every extension, including .info.json/.part. */
export function nameInStem(name: string, stem: string): boolean {
  return portableFilenameIdentity(name).startsWith(`${portableFilenameIdentity(stem)}.`)
}

function stemsOverlap(first: string, second: string): boolean {
  return first === second || nameInStem(first, second) || nameInStem(second, first)
}

/** Live catalog ownership also reserves each download/cleanup ID namespace,
 * before a queued tape has any filenames. Legacy conflicting rows stay visible
 * to callers rather than being repaired or deleted here. */
export function catalogFilenameOwner(tapes: readonly Tape[], name: string, exceptId?: string): string | undefined {
  const identity = portableFilenameIdentity(name)
  return tapes.find((tape) => tape.id !== exceptId && (
    TRACKED_FILENAME_FIELDS.some((field) => tape[field] !== null && portableFilenameIdentity(tape[field]!) === identity) ||
    nameInStem(name, tape.id)
  ))?.id
}

export function catalogStemOwner(tapes: readonly Tape[], stem: string, exceptId?: string): string | undefined {
  const identity = portableFilenameIdentity(stem)
  return tapes.find((tape) => tape.id !== exceptId && (
    stemsOverlap(identity, portableFilenameIdentity(tape.id)) ||
    TRACKED_FILENAME_FIELDS.some((field) => tape[field] !== null && nameInStem(tape[field]!, stem))
  ))?.id
}

export function managedFilenameClaimed(directory: string, name: string): boolean {
  const counts = directories.get(resolve(directory))
  const identity = portableFilenameIdentity(name)
  return !!counts && (counts.names.has(identity) || [...counts.stems.keys()].some((stem) => nameInStem(identity, stem)))
}

function managedStemClaimed(directory: string, stem: string): boolean {
  const counts = directories.get(resolve(directory))
  const identity = portableFilenameIdentity(stem)
  return !!counts && (
    [...counts.names.keys()].some((name) => nameInStem(name, identity)) ||
    [...counts.stems.keys()].some((other) => stemsOverlap(identity, other))
  )
}

/** Claim synchronously before physical work, retaining it through primitive
 * failure cleanup, rollback, Trash and catalog settlement. Counts let separate
 * retiring effects on portable-equivalent names settle independently. The
 * library-write owner keeps this logical directory stable; only export needs
 * to establish whether its selected directory is physically that library. */
export function claimManagedFiles(directory: string, namespace: Namespace): () => void {
  const key = resolve(directory)
  let counts = directories.get(key)
  if (!counts) {
    counts = { names: new Map(), stems: new Map() }
    directories.set(key, counts)
  }
  const names = new Set(namespace.names?.map(portableFilenameIdentity))
  const stems = new Set(namespace.stems?.map(portableFilenameIdentity))
  for (const name of names) counts.names.set(name, (counts.names.get(name) ?? 0) + 1)
  for (const stem of stems) counts.stems.set(stem, (counts.stems.get(stem) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    for (const [keys, values] of [[names, counts.names], [stems, counts.stems]] as const) {
      for (const item of keys) {
        const remaining = values.get(item)! - 1
        if (remaining === 0) values.delete(item)
        else values.set(item, remaining)
      }
    }
    if (counts.names.size === 0 && counts.stems.size === 0) directories.delete(key)
  }
}

/** Refuse overlapping producers; cleanup may add a counted claim of its own. */
export function tryClaimManagedFiles(directory: string, namespace: Namespace): (() => void) | null {
  if (namespace.names?.some((name) => managedFilenameClaimed(directory, name)) ||
    namespace.stems?.some((stem) => managedStemClaimed(directory, stem))) return null
  return claimManagedFiles(directory, namespace)
}
