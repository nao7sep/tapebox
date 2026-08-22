import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { handle } from './handle'
import { caseInsensitiveSiblingExists, removeTapes } from './library'
import * as session from '@main/store/session'
import { getLibraryDir } from '@main/store/config'
import { planExport } from '@main/core/export-plan'
import { SidecarTapeBoxSchema } from '@shared/domain'
import { log } from '@main/io/logger'
import { writeFileAtomicNoOverwriteVia } from '@main/io/atomic-file'

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
    const plan = planExport(
      { filename: tape.filename, thumbnailFilename: tape.thumbnailFilename },
      destinationDir,
      name,
    )
    if (plan.status === 'error') throw new Error(plan.message)
    const { cleanName, mediaName, sidecarName, thumbName: newThumbName } = plan

    const libDir = getLibraryDir()
    const mediaDst = join(destinationDir, mediaName)
    const sidecarDst = join(destinationDir, sidecarName)
    const thumbDst = newThumbName ? join(destinationDir, newThumbName) : null

    // Case-insensitive so a sibling differing only in case (which macOS/Windows would
    // silently clobber) is refused too, per storage-path-conventions' invariant.
    const writtenPaths = [mediaDst, sidecarDst, ...(thumbDst ? [thumbDst] : [])]
    for (const dst of writtenPaths) {
      if (await caseInsensitiveSiblingExists(dst)) {
        throw new Error(`A file already exists at the destination: ${dst}`)
      }
    }

    // Read + rewrite + validate the sidecar's tapebox namespace UP FRONT — before any
    // file is copied out — so a corrupt source sidecar (or a rewrite that would
    // downgrade it below what import accepts) fails the export before it leaves
    // partial files in the user's folder.
    const sidecar = JSON.parse(await readFile(join(libDir, tape.sidecarFilename), 'utf8')) as Record<string, unknown>
    const tb = (sidecar['tapebox'] as Record<string, unknown> | undefined) ?? {}
    tb['name'] = cleanName
    tb['mediaFilename'] = mediaName
    tb['thumbnailFilename'] = newThumbName
    sidecar['tapebox'] = SidecarTapeBoxSchema.parse(tb)

    // not recorded: media, thumbnail, and rewritten sidecar are one exported bundle
    // written to the user's chosen destination and then forgotten. They are OUTPUT,
    // and the sidecar is also colocated with binary media, so none enters backups.
    const committed: string[] = []
    try {
      await writeFileAtomicNoOverwriteVia(mediaDst, (temp) => copyFile(join(libDir, tape.filename!), temp))
      committed.push(mediaDst)
      if (thumbDst && tape.thumbnailFilename) {
        await writeFileAtomicNoOverwriteVia(thumbDst, (temp) => copyFile(join(libDir, tape.thumbnailFilename!), temp))
        committed.push(thumbDst)
      }
      const sidecarBytes = Buffer.from(JSON.stringify(sidecar, null, 2) + '\n', 'utf8')
      await writeFileAtomicNoOverwriteVia(sidecarDst, (temp) => writeFile(temp, sidecarBytes))
      committed.push(sidecarDst)
    } catch (err) {
      await Promise.all(committed.map((path) => unlink(path).catch(() => {})))
      throw err
    }

    log.info('export:files', { tapeId, destinationDir, deleteFromApp, count: writtenPaths.length })

    // Copies are safely written; only now take the tape out of the library. The copy
    // already succeeded, so a discard failure must say "exported, but the original
    // wasn't removed" rather than leave an untracked orphan while claiming success.
    if (deleteFromApp) {
      const { failed } = await removeTapes([tapeId], true)
      if (failed.length > 0) {
        throw new Error(`Exported, but couldn't remove the original from the library: ${failed[0].error}`)
      }
    }

    return { writtenPaths }
  })
}
