import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { handle } from './handle'
import { removeTapesFrom } from './collection'
import * as session from '@main/store/session'
import { planExport } from '@main/core/export-plan'
import { exportNamespace, readSidecarFile, SIDECAR_JSON, type Sidecar } from '@main/core/sidecar'
import { tapeFile } from '@main/paths'
import { serializeStoreJson } from '@main/io/atomic-json'
import { maskYtdlpOutput, maskUrlCredentials } from '@main/io/mask'
import { log } from '@main/io/logger'
import {
  copyFileNoOverwrite,
  directorySupportsHardLinks,
  unlinkFiles,
  writeFileAtomicNoOverwriteVia,
} from '@main/io/atomic-file'
import { portableSiblingExists } from '@main/io/portable-directory'
import { runCancellable } from '@main/work-registry'
import { withCollectionTurn } from '@main/collection-writes'
import type { IpcCalls } from '@shared/ipc-contract'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'
import { nowUtcIso } from '@shared/utc'

/**
 * export:files — copy a tape out of the collection, verbatim. No transcoding:
 * TapeBox is a thin wrapper, not a converter. The media and its thumbnail (if any)
 * are byte-for-byte copies; the sidecar is copied with a tapebox section written
 * from its tape.json under the exported names, so the bundle stays re-importable,
 * and with renamedAtUtc set when the name changes. All three land in
 * destinationDir under `name`.
 *
 * Pre-flight refuses if any destination file already exists, so a partial export
 * can't half-overwrite something in the user's folder. When deleteFromApp is set,
 * the tape is then removed from the collection (its originals trashed/deleted per the
 * Trash setting), making export a "move out".
 */
export function registerExportHandlers(): void {
  // A collection turn: the export reads the collection's files and, with
  // deleteFromApp, removes them.
  handle('export:files', (req) => runCancellable((signal) =>
    withCollectionTurn((collectionDir) => exportTape(req, collectionDir, signal))))
}

/**
 * Copy one tape out. Each media byte is written once: into a temp that is linked
 * into place where the destination supports hard links, or straight into an
 * exclusive claim on the final name where it does not (exFAT/FAT32 sticks).
 * Quitting aborts between chunks and rolls back every file already published.
 */
async function exportTape(
  { tapeId, destinationDir, name, deleteFromApp }: IpcCalls['export:files']['req'],
  collectionDir: string,
  signal: AbortSignal,
): Promise<IpcCalls['export:files']['res']> {
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
  if (plan.status === 'error') throw new UserFacingError('invalid', plan.message)
  const { cleanName, mediaName, sidecarName, thumbName: newThumbName } = plan

  const mediaDst = join(destinationDir, mediaName)
  const sidecarDst = join(destinationDir, sidecarName)
  const thumbDst = newThumbName ? join(destinationDir, newThumbName) : null

  // Case-insensitive so a sibling differing only in case (which macOS/Windows would
  // silently clobber) is refused too, per storage-path-conventions' invariant.
  const writtenPaths = [mediaDst, sidecarDst, ...(thumbDst ? [thumbDst] : [])]
  for (const dst of writtenPaths) {
    if (await portableSiblingExists(dst)) {
      throw new UserFacingError('conflict', message('errors.exportDestinationExists', { path: dst }))
    }
  }

  // Read the sidecar and write its tapebox section UP FRONT — before any file is
  // copied out — so a corrupt source sidecar fails the export before it leaves
  // partial files in the user's folder.
  const original = await readSidecarFile(tapeFile(collectionDir, tape, tape.sidecarFilename))
  const sidecar = JSON.parse(maskUrlCredentials(maskYtdlpOutput(JSON.stringify(original)))) as Sidecar
  const tb = exportNamespace(sidecar, tape)
  // The tape's source URL leaves under the same masking as the sidecar.
  tb['sourceUrl'] = maskUrlCredentials(maskYtdlpOutput(tape.sourceUrl))
  // Exporting under another name renames the bundle, so the sidecar records when.
  if (tb['name'] !== cleanName) tb['renamedAtUtc'] = nowUtcIso()
  tb['name'] = cleanName
  tb['mediaFilename'] = mediaName
  tb['thumbnailFilename'] = newThumbName
  sidecar['tapebox'] = tb

  // not recorded: media, thumbnail, and rewritten sidecar are one exported bundle
  // written to the user's chosen destination and then forgotten. They are OUTPUT,
  // and the sidecar is also colocated with binary media, so none enters backups.
  const committed: string[] = []
  try {
    const hardLinks = await directorySupportsHardLinks(destinationDir)
    await copyFileNoOverwrite(tapeFile(collectionDir, tape, tape.filename), mediaDst, { hardLinks, signal })
    committed.push(mediaDst)
    if (thumbDst && tape.thumbnailFilename) {
      await copyFileNoOverwrite(tapeFile(collectionDir, tape, tape.thumbnailFilename), thumbDst, { hardLinks, signal })
      committed.push(thumbDst)
    }
    signal.throwIfAborted()
    const sidecarBytes = Buffer.from(serializeStoreJson(sidecar, SIDECAR_JSON), 'utf8')
    await writeFileAtomicNoOverwriteVia(sidecarDst, (temp) => writeFile(temp, sidecarBytes))
    committed.push(sidecarDst)
  } catch (err) {
    try {
      await unlinkFiles(committed)
    } catch (cleanupError) {
      throw new AggregateError(
        [err, cleanupError],
        `Export failed: ${String(err)}. Published files could not be fully cleaned up.`,
      )
    }
    throw err
  }

  log.info('export:files', { tapeId, destinationDir, deleteFromApp, count: writtenPaths.length })

  // Copies are safely written; only now take the tape out of the collection. The copy
  // already succeeded, so a discard failure must say "exported, but the original
  // wasn't removed" rather than leave an untracked orphan while claiming success.
  if (deleteFromApp) {
    const { failed } = await removeTapesFrom(collectionDir, [tapeId], true)
    if (failed.length > 0) {
      throw new UserFacingError('conflict', message('errors.exportOriginalsKept'))
    }
  }

  return { writtenPaths }
}

