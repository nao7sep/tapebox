import { extname, isAbsolute } from 'node:path'

import { sanitizeFilename } from '@main/core/filename'

// The pure destination-naming decision behind `export:files`, lifted out of the
// IPC handler: the sanitized name, the destination filenames, the absolute-path
// requirement, and the same intra-plan collision guard the rename path uses.

export type ExportPlan =
  | { status: 'error'; message: string }
  | { status: 'ok'; cleanName: string; mediaName: string; sidecarName: string; thumbName: string | null }

export function planExport(
  tape: { filename: string; thumbnailFilename: string | null },
  destinationDir: string,
  rawName: string,
): ExportPlan {
  const cleanName = sanitizeFilename(rawName)
  if (!cleanName) {
    return { status: 'error', message: 'Name is empty after removing characters the filesystem rejects.' }
  }

  // The destination is a GUI-supplied folder; require it absolute so a relative
  // value can never join against the working directory (storage-path-conventions).
  if (!isAbsolute(destinationDir)) {
    return { status: 'error', message: `Export destination must be an absolute folder path: ${destinationDir}` }
  }

  const mediaName = `${cleanName}${extname(tape.filename)}`
  const sidecarName = `${cleanName}.json`
  const thumbName = tape.thumbnailFilename ? `${cleanName}${extname(tape.thumbnailFilename)}` : null

  // Same collision guard as the rename path: two artifacts must not map to one
  // destination name (e.g. media and thumbnail sharing an extension), which the
  // per-file existence checks cannot catch when neither destination exists yet.
  const names = [mediaName, sidecarName, ...(thumbName ? [thumbName] : [])]
  const collided = names.find((name, index) => names.indexOf(name) !== index)
  if (collided) {
    return {
      status: 'error',
      message: `Exporting would write two of this tape's files to the same name: ${collided}.`,
    }
  }

  return { status: 'ok', cleanName, mediaName, sidecarName, thumbName }
}
