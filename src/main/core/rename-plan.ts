import { extname } from 'node:path'
import { nanoid } from 'nanoid'

import { portableFilenameIdentity, sanitizeFilename } from '@main/core/filename'

// The pure naming/file-op planning behind `library:rename`, lifted out of the IPC
// handler so the derived names, the no-op short-circuit, and — critically — the
// intra-plan collision guard are testable without touching disk.

export type RenameArtifact = 'media' | 'sidecar' | 'thumbnail'

export interface RenamePlanItem {
  artifact: RenameArtifact
  /** The tape's current filename for this artifact. */
  old: string
  /** The filename it should carry after the rename. */
  fresh: string
  /** The `<stem>-<nanoid>.tmp` staging filename it is built under before the atomic swap. */
  stage: string
}

export type RenamePlan =
  | { status: 'noop' }
  | { status: 'error'; message: string }
  | {
      status: 'rename'
      cleanName: string
      newMediaName: string
      newSidecarName: string
      newThumbName: string | null
      items: RenamePlanItem[]
    }

export function planRename(
  tape: { filename: string; sidecarFilename: string; thumbnailFilename: string | null },
  rawName: string,
): RenamePlan {
  // Any filesystem-safe name, not just a slug — sanitizeFilename preserves Unicode
  // and strips only reserved characters. Empty after that = no real name.
  const cleanName = sanitizeFilename(rawName)
  if (!cleanName) {
    return { status: 'error', message: 'Name is empty after removing characters the filesystem rejects.' }
  }

  const newMediaName = `${cleanName}${extname(tape.filename)}`
  const newSidecarName = `${cleanName}.json`
  const newThumbName = tape.thumbnailFilename ? `${cleanName}${extname(tape.thumbnailFilename)}` : null

  if (
    newMediaName === tape.filename &&
    newSidecarName === tape.sidecarFilename &&
    newThumbName === tape.thumbnailFilename
  ) {
    return { status: 'noop' }
  }

  const items: RenamePlanItem[] = [
    { artifact: 'media' as const, old: tape.filename, fresh: newMediaName },
    { artifact: 'sidecar' as const, old: tape.sidecarFilename, fresh: newSidecarName },
    ...(tape.thumbnailFilename && newThumbName
      ? [{ artifact: 'thumbnail' as const, old: tape.thumbnailFilename, fresh: newThumbName }]
      : []),
  ].map((it) => {
    // <stem>-<nanoid>.tmp per the atomic-write-temp-files convention: the nanoid
    // discriminator keeps the three artifacts' staging names distinct even when
    // their `fresh` names share a stem (media/sidecar/thumbnail all named cleanName).
    const stem = it.fresh.slice(0, -extname(it.fresh).length)
    return { ...it, stage: `${stem}-${nanoid(10)}.tmp` }
  })

  // Collision guard: two of this tape's artifacts must not derive the same target
  // name (e.g. a media file and a thumbnail that share an extension both map to
  // "<name>.<ext>"). The handler's per-file existence checks cannot catch this —
  // neither target exists on disk yet — so without this guard the staging build
  // and atomic swap would clobber one file with the other.
  const fresh = items.map((it) => it.fresh)
  const freshIdentities = fresh.map(portableFilenameIdentity)
  const collided = fresh.find((_name, index) => freshIdentities.indexOf(freshIdentities[index]!) !== index)
  if (collided) {
    return {
      status: 'error',
      message: `Renaming would map two of this tape's files to the same name: ${collided}.`,
    }
  }

  return { status: 'rename', cleanName, newMediaName, newSidecarName, newThumbName, items }
}
