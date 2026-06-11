import { copyFile, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { handle } from './handle'
import { removeTapes } from './library'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { sanitizeFilename } from '@main/core/filename'
import { log } from '@main/io/logger'

/**
 * export:files — copy a tape out of the library, verbatim. No transcoding:
 * TapeBox is a thin wrapper, not a converter. The media and its thumbnail (if any)
 * are byte-for-byte copies; the sidecar is copied with its tapebox.name /
 * thumbnailFilename rewritten to the exported names so the bundle stays
 * re-importable. All three land in destinationDir under `name`.
 *
 * Pre-flight refuses if any destination file already exists, so a partial export
 * can't half-overwrite something in the user's folder. When deleteFromApp is set,
 * the tape is then removed from the library (its originals trashed/deleted per the
 * Trash setting), making export a "move out".
 */
export function registerExportHandlers(): void {
  handle('export:files', async ({ tapeId, destinationDir, name, deleteFromApp }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)
    if (!tape.filename || !tape.sidecarFilename) {
      throw new Error('Tape has no files on disk to export.')
    }
    const cleanName = sanitizeFilename(name)
    if (!cleanName) {
      throw new Error('Name is empty after removing characters the filesystem rejects.')
    }

    const libDir = getSettings().libraryDir
    const newThumbName = tape.thumbnailFilename ? `${cleanName}${extname(tape.thumbnailFilename)}` : null

    const mediaDst = join(destinationDir, `${cleanName}${extname(tape.filename)}`)
    const sidecarDst = join(destinationDir, `${cleanName}.json`)
    const thumbDst = newThumbName ? join(destinationDir, newThumbName) : null

    const writtenPaths = [mediaDst, sidecarDst, ...(thumbDst ? [thumbDst] : [])]
    for (const dst of writtenPaths) {
      if (await exists(dst)) throw new Error(`A file already exists at the destination: ${dst}`)
    }

    // Media + thumbnail: byte-for-byte copies.
    await copyFile(join(libDir, tape.filename), mediaDst)
    if (thumbDst && tape.thumbnailFilename) {
      await copyFile(join(libDir, tape.thumbnailFilename), thumbDst)
    }

    // Sidecar: rewrite the tapebox names so the exported copy describes its own
    // files (re-importable as-is), then write it out.
    const sidecar = JSON.parse(await readFile(join(libDir, tape.sidecarFilename), 'utf8')) as Record<string, unknown>
    const tb = (sidecar['tapebox'] as Record<string, unknown> | undefined) ?? {}
    tb['name'] = cleanName
    tb['mediaFilename'] = `${cleanName}${extname(tape.filename)}`
    tb['thumbnailFilename'] = newThumbName
    sidecar['tapebox'] = tb
    await writeJsonAtomic(sidecarDst, sidecar)

    log.info('export:files', { tapeId, destinationDir, deleteFromApp, count: writtenPaths.length })

    // Copies are safely written; only now take the tape out of the library.
    if (deleteFromApp) await removeTapes([tapeId], true)

    return { writtenPaths }
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
