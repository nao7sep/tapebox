import { TRACKED_FILENAME_FIELDS, type Tape } from '@shared/domain'
import { portableFilenameIdentity } from '@shared/filename'

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
