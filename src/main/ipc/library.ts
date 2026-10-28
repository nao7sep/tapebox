import { access, constants, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { shell } from 'electron'
import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit, sendTo } from './events'
import * as session from '@main/store/session'
import { getLibraryDir, getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import {
  copyFileNoOverwrite,
  directorySupportsHardLinks,
  linkOrCopyNoOverwrite,
  unlinkFiles,
  writeFileAtomicNoOverwriteVia,
} from '@main/io/atomic-file'
import { serializeStoreJson } from '@main/io/atomic-json'
import { openExternalPlayer } from '@main/io/external-player'
import { FORMAT_VERSIONS, NewerFormatError, parseStoreJson } from '@main/io/format-version'
import { portableSiblingExists } from '@main/io/portable-directory'
import { planRename } from '@main/core/rename-plan'
import { readSidecarFile, sidecarNamespace, SIDECAR_JSON, writeSidecar } from '@main/core/sidecar'
import { portableFilenameIdentity } from '@main/core/filename'
import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import { unsupportedSelectedPaths } from '@main/core/import-selection'
import * as queue from '@main/queue/manager'
import { cancelWork, runCancellable } from '@main/work-registry'
import { withLibraryTurn } from '@main/library-writes'
import { type SourceRef } from '@shared/source-identity'
import { downloadThumbnail, probe } from '@main/services/ytdlp'
import { saveThumbnailJpeg } from '@main/services/ffmpeg'
import { nowUtcIso } from '@shared/utc'
import { frontOrders } from '@shared/order'
import { TRACKED_FILENAME_FIELDS, type Tape } from '@shared/domain'
import type { ImportIssue, ImportResult, RefreshedMetadata, SidecarRaw } from '@shared/ipc-contract'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'
import { ALREADY_IN_LIBRARY } from '@shared/import-issues'

const PASSIVE_MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.mpg', '.mpeg', '.ogv', '.flv', '.wmv', '.3gp', '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.aiff'])

export function registerLibraryHandlers(): void {
  session.onCatalogSaveFailure(() => emit('library:saveFailed', null))

  // The catalog goes as this subscription's first event, sent in the same turn
  // as any later change would be, so the window needs no second source.
  handle('library:subscribe', async (_req, event) => {
    sendTo(event.sender, 'library:current', { tapes: session.getTapes(), boxes: session.getBoxes() })
  })

  handle('library:archive', async ({ tapeIds }) => {
    const at = nowUtcIso()
    const archivable = tapeIds
      .map((id) => session.getTape(id))
      .filter((t): t is Tape => !!t && !t.archivedAtUtc)
    if (archivable.length === 0) return
    // Archived tapes start in Unboxed, on top — the newly-archived block lands above
    // whatever's already there, in the order it was selected.
    const unboxed = session.getTapes().filter((t) => t.archivedAtUtc && t.boxId === null)
    const orders = frontOrders(unboxed.map((t) => t.order), archivable.length)
    archivable.forEach((tape, i) => {
      const updated = { ...tape, archivedAtUtc: at, boxId: null, order: orders[i] }
      session.upsertTape(updated)
    })
    emit('tapes:updatedMany', archivable.map((tape) => session.getTape(tape.id)!))
  })

  handle('library:unarchive', async ({ tapeIds }) => {
    const restorable = tapeIds
      .map((id) => session.getTape(id))
      .filter((t): t is Tape => !!t && !!t.archivedAtUtc)
    if (restorable.length === 0) return
    // Leaving the archive drops all archive organization (box membership) and
    // returns the tape to the top of the inbox, like a fresh add.
    const inbox = session.getTapes().filter((t) => !t.archivedAtUtc)
    const orders = frontOrders(inbox.map((t) => t.order), restorable.length)
    restorable.forEach((tape, i) => {
      const updated = { ...tape, archivedAtUtc: null, boxId: null, order: orders[i] }
      session.upsertTape(updated)
    })
    emit('tapes:updatedMany', restorable.map((tape) => session.getTape(tape.id)!))
  })

  // Reindex one list (the inbox, a box, or Unboxed) to the caller's sequence after
  // a drag — order = position, top first. Membership (archived / box) is left
  // untouched; this is reorder-in-place, not a move between lists.
  //
  // Reindex the targeted list's FULL membership rather than blindly numbering the
  // caller's ids 0..n-1: ids that vanished (a concurrent removal) are ignored, and
  // any members the caller didn't name keep their place after the named ones. So a
  // partial or stale set can never collide orders with the rest of the same list.
  handle('tapes:reorder', async ({ orderedIds }) => {
    const changed = await session.reorderTapesDurably(orderedIds)
    if (changed.length > 0) emit('tapes:updatedMany', changed)
  })

  // Registered as work so a quit waits for it, files and catalog commit alike,
  // before its final catalog save. Removal is not abandoned midway: it settles.
  handle('library:remove', ({ tapeIds, deleteFiles }) => runCancellable(async () => {
    const { failed } = await removeTapes(tapeIds, deleteFiles)
    // Tapes whose files couldn't be discarded are KEPT (not removed from the list);
    // surface the failure so the user is never told a removal succeeded while the
    // files (and the catalog entry) actually remain.
    if (failed.length > 0) {
      throw new UserFacingError('conflict', message('errors.removeFilesKept', { count: failed.length }))
    }
  }))

  handle('library:getSidecar', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape || !tape.sidecarFilename) {
      throw new Error(`Sidecar not available for tape ${tapeId}`)
    }
    return await readSidecarFile(join(getLibraryDir(), tape.sidecarFilename)) as SidecarRaw
  })

  handle('library:reveal', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape?.filename) throw new Error('No file to reveal for this tape')
    shell.showItemInFolder(join(getLibraryDir(), tape.filename))
  })

  handle('library:playExternal', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape?.filename) throw new Error('No file to play for this tape')
    const full = join(getLibraryDir(), tape.filename)
    const player = getSettings().externalPlayer.trim()

    if (!player) {
      // Imported names are untrusted: OS-active files must never be launched as media.
      if (!PASSIVE_MEDIA_EXTENSIONS.has(extname(tape.filename).toLowerCase())) {
        throw new UserFacingError('refused', message('errors.externalPlayerRequired'))
      }
      const error = await shell.openPath(full) // '' on success, message on failure
      if (error) throw new Error(error)
      return
    }
    await openExternalPlayer(player, full)
  })

  handle('library:rename', ({ tapeId, name }) => runCancellable((signal) =>
    withLibraryTurn((libraryDir) => renameTape(tapeId, name, libraryDir, signal))))

  handle('library:probeMetadata', async ({ tapeId, requestId }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)

    // One deliberate re-probe, read-only. The probe's own idle watchdog guards a
    // stall, and it is never auto-retried — re-hammering the source is the user's
    // call. Nothing is written here: the caller reviews this and decides.
    const result = await runCancellable((signal) => probe(tape.id, tape.sourceUrl, signal), `metadata-probe:${requestId}`)
    const probedAtUtc = nowUtcIso()
    if (result.kind === 'page') {
      throw new UserFacingError('refused', message('errors.linkNowList'))
    }
    return {
      title: result.title,
      uploader: result.uploader,
      description: result.description,
      probedAtUtc,
    }
  })

  handle('library:cancelMetadataProbe', async ({ requestId }) => {
    cancelWork(`metadata-probe:${requestId}`)
  })

  // Writes the sidecar and may save a poster into the library, so it takes a library turn.
  handle('library:applyMetadata', ({ tapeId, metadata }) => runCancellable((signal) =>
    withLibraryTurn((dir) => applyMetadata(tapeId, metadata, dir, signal))))

  // Sidecar-driven import: the whole selection arrives here so this filesystem-owning
  // boundary can tell referenced bundle companions from unsupported extras. One
  // sidecar = one tape, so a duplicate is reported once, not once per selected file.
  handle('library:import', ({ paths }) => runCancellable((signal) =>
    withLibraryTurn((libraryDir) => importBundles(paths, libraryDir, signal))))
}

async function applyMetadata(tapeId: string, metadata: RefreshedMetadata, dir: string, signal: AbortSignal): Promise<Tape> {
  const existing = session.getTape(tapeId)
  if (!existing) throw new Error(`Tape not found: ${tapeId}`)
  if (queue.isActive(tapeId)) throw new UserFacingError('refused', message('errors.tapeBusy'))
  const tape = structuredClone(existing)
  // Refuse a protected sidecar before attempting its optional poster backfill.
  const sidecar = tape.sidecarFilename ? await readSidecarFile(join(dir, tape.sidecarFilename)) : null

  // Backfill a local poster for a downloaded tape that has none — e.g. one
  // downloaded before thumbnails were saved locally. Best-effort: the catalog
  // metadata the user reviewed must still apply even if the fetch fails. Routed
  // through the same image gate as a fresh download.
  let thumbnailFilename = tape.thumbnailFilename
  // The raw fetch uses a private name under the tape ID; conversion replaces
  // the literal media-stem JPEG, so no other tape may own either stem.
  if (thumbnailFilename === null && tape.filename && !session.stemOwner(tapeId, tapeId)) {
    const stem = tape.filename.slice(0, -extname(tape.filename).length)
    try {
      if (await posterStemFree(tape, dir, stem)) {
        const raw = await downloadThumbnail(tape.id, tape.sourceUrl, dir, signal)
        try {
          thumbnailFilename = raw ? await saveThumbnailJpeg(tape.id, raw, dir, stem, signal) : null
        } finally {
          // A returned raw file belongs to this caller until conversion or a
          // stale result settles. The image gate may already have consumed it.
          if (raw) {
            await unlink(raw).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('thumbnail scratch cleanup failed', { tapeId, error: describeError(error) })
            })
          }
        }
      } else {
        log.warn('thumbnail backfill skipped; another file has the poster name', { tapeId, stem })
      }
    } catch (err) {
      log.warn('thumbnail backfill failed', { tapeId, error: describeError(err) })
    }
  }
  signal.throwIfAborted()

  // The sidecar is the bundle's own record: export carries it and import reads
  // its title, uploader and poster back. So it takes everything the catalog is
  // about to hold, and it is written before the catalog, so a failed write leaves
  // the catalog as it was rather than the two disagreeing. A poster fetched for
  // it stays in the library under the tape's own stem, for the next Apply.
  if (tape.sidecarFilename) {
    await writeRefreshedSidecar(join(dir, tape.sidecarFilename), metadata, thumbnailFilename, tape, sidecar!)
  }

  // Once the sidecar has committed, Apply finishes with its catalog commit even if
  // it is cancelled or the app is quitting, so the two never disagree. No other
  // file action runs during this turn.
  const current = session.getTape(tapeId)
  if (!current) throw new Error(`Tape not found: ${tapeId}`)

  // Persist the accepted catalog fields. Duration and chapter count are NOT here:
  // they're fixed by the file and can't change unless it's replaced. sourceId and
  // the on-disk filenames are the tape's identity — left untouched.
  const updated: Tape = {
    ...current,
    title: metadata.title,
    uploader: metadata.uploader,
    thumbnailFilename,
    probedAtUtc: metadata.probedAtUtc,
  }
  session.upsertTape(updated)
  emit('tapes:updated', updated)
  let saved: boolean
  try { saved = await session.persistNow() } catch (error) {
    throw new UserFacingError('refused', message('refresh.applyPartial'), { cause: error })
  }
  if (!saved) throw new UserFacingError('refused', message('refresh.applyPartial'))
  log.info('applied refreshed metadata', { tapeId: tape.id })
  return updated
}

/**
 * Whether a poster can be fetched under `stem` without touching a file that is not
 * the tape's own: the image gate replaces the literal `<stem>.jpg`; the raw
 * fetch uses an opaque scratch name under the tape ID. No other tape may own a
 * name with this poster stem, and no entry in the library may spell the stem
 * differently (storage-path-conventions);
 * an entry spelled exactly is the tape's own, such as a poster an earlier Apply
 * left for the next one.
 */
async function posterStemFree(tape: Tape, dir: string, stem: string): Promise<boolean> {
  const identity = portableFilenameIdentity(stem)
  const stemOf = (name: string) => name.slice(0, name.length - extname(name).length)
  if (session.stemOwner(stem, tape.id)) return false
  const entries = await readdir(dir)
  return entries.every((name) => stemOf(name) === stem || portableFilenameIdentity(stemOf(name)) !== identity)
}

/**
 * Put accepted metadata into a tape's sidecar: the title, uploader and description
 * in yt-dlp's own fields, and the poster in the tapebox section. A sidecar that
 * already holds every value is left as it is.
 */
async function writeRefreshedSidecar(
  path: string,
  metadata: RefreshedMetadata,
  thumbnailFilename: string | null,
  tape: Tape,
  sidecar: Record<string, unknown>,
): Promise<void> {
  let changed = false
  const fields = { title: metadata.title, uploader: metadata.uploader, description: metadata.description }
  for (const [key, value] of Object.entries(fields)) {
    if ((sidecar[key] ?? null) === value) continue
    sidecar[key] = value
    changed = true
  }
  const tb = sidecar['tapebox']
  if (tb && typeof tb === 'object' && (tb as Record<string, unknown>)['thumbnailFilename'] !== thumbnailFilename) {
    sidecar['tapebox'] = { ...sidecarNamespace(sidecar, tape), thumbnailFilename }
    changed = true
  }
  if (!changed) return
  // not recorded: the sidecar is library-directory content, colocated with binary
  // media, so it is excluded (data-backup conventions) and takes the raw
  // writeJsonAtomic, not the choke point.
  await writeSidecar(path, sidecar)
}

/**
 * Import sidecar-driven bundles into the library. Each file is copied once (into
 * a temp that is linked into place where the library supports hard links), and
 * quitting stops the import between chunks, rolling back the bundle in progress.
 */
async function importBundles(paths: string[], libraryDir: string, signal: AbortSignal): Promise<ImportResult> {
  const hardLinks = await directorySupportsHardLinks(libraryDir)
  const destinationNames = new Set((await readdir(libraryDir)).map(portableFilenameIdentity))
  const imported: Tape[] = []
  const issues: ImportIssue[] = []
  const sidecarPaths = paths.filter((path) => extname(path).toLowerCase() === '.json')
  const claimedCompanionPaths: string[] = []

  for (const sidecarPath of sidecarPaths) {
    if (signal.aborted) break
    // Defensive: only sidecars drive an import (the caller filters already).
    if (extname(sidecarPath).toLowerCase() !== '.json') continue
    const dir = dirname(sidecarPath)

    let rawSidecar: string
    try {
      rawSidecar = await readFile(sidecarPath, 'utf8')
    } catch (err) {
      log.error('import sidecar read failed', { path: sidecarPath, error: describeError(err) })
      issues.push({
        path: sidecarPath,
        reason: message('import.sidecarUnreadable'),
        severity: 'error',
      })
      continue
    }

    let sidecar: Record<string, unknown>
    try {
      sidecar = JSON.parse(rawSidecar)
    } catch (err) {
      issues.push({
        path: sidecarPath,
        reason: message('import.sidecarInvalidJson'),
        severity: 'warning',
      })
      continue
    }

    const classification = classifyImport(sidecar)
    if (classification.status === 'reject') {
      issues.push({ path: sidecarPath, reason: classification.reason, severity: 'warning' })
      continue
    }
    const { sourceUrl, mediaFilename, thumbnailFilename: tbThumb } = classification
    claimedCompanionPaths.push(join(dir, mediaFilename))
    if (tbThumb) claimedCompanionPaths.push(join(dir, tbThumb))

    const source: SourceRef = {
      url: sourceUrl,
      extractor: typeof sidecar['extractor'] === 'string' ? sidecar['extractor'] : null,
      sourceId: typeof sidecar['id'] === 'string' ? sidecar['id'] : null,
    }
    // Library names follow the media file's stem so the bundle stays internally
    // consistent regardless of the sidecar's own name. Admit its source and every
    // tracked filename before awaiting any of the companion-file work.
    const mediaStem = mediaFilename.slice(0, -extname(mediaFilename).length)
    const bundleNames = [mediaFilename, `${mediaStem}.json`]
    const conflict = importBundleConflict(source, bundleNames, sidecarPath)
    if (conflict) {
      issues.push(conflict)
      continue
    }
    const thumbnailTaken = tbThumb !== null && !!session.filenameOwner(tbThumb)

    const srcMedia = join(dir, mediaFilename)
    try {
      await access(srcMedia, constants.R_OK)
    } catch {
      issues.push({
        path: sidecarPath,
        reason: message('import.mediaMissing', { name: mediaFilename }),
        severity: 'warning',
      })
      continue
    }

    const targetMedia = join(libraryDir, mediaFilename)
    const targetSidecar = join(libraryDir, `${mediaStem}.json`)
    const copied: string[] = []
    try {
      // not recorded: import copies a bundle into the library, transient app-owned
      // content until exported (developer classification). The new catalog row,
      // the user's library membership, is what is backed up.
      if (srcMedia !== targetMedia) {
        assertImportDestination(targetMedia, destinationNames)
        await copyFileNoOverwrite(srcMedia, targetMedia, { hardLinks, signal })
        copied.push(targetMedia)
        destinationNames.add(portableFilenameIdentity(basename(targetMedia)))
      }
      if (sidecarPath !== targetSidecar) {
        assertImportDestination(targetSidecar, destinationNames)
        await copyFileNoOverwrite(sidecarPath, targetSidecar, { hardLinks, signal })
        copied.push(targetSidecar)
        destinationNames.add(portableFilenameIdentity(basename(targetSidecar)))
      }
    } catch (err) {
      try {
        await unlinkFiles(copied)
        for (const path of copied) destinationNames.delete(portableFilenameIdentity(basename(path)))
        log.error('import bundle copy failed', {
          path: sidecarPath,
          error: describeError(err),
        })
        issues.push({
          path: sidecarPath,
          reason: message('import.copyFailed'),
          severity: 'error',
        })
      } catch (cleanupError) {
        const failure = new AggregateError(
          [err, cleanupError],
          `Copy into library failed: ${String(err)}. Published files could not be fully cleaned up.`,
        )
        log.error('import bundle copy and rollback failed', {
          path: sidecarPath,
          error: describeError(failure),
        })
        issues.push({
          path: sidecarPath,
          reason: message('import.copyIncomplete'),
          severity: 'error',
        })
      }
      continue
    }

    // Bring the local poster along if the sidecar names one and it's sitting beside
    // it. Best-effort: a missing or unreadable thumbnail just imports the tape
    // without a poster — it never rejects the import.
    let thumbnailFilename: string | null = null
    if (tbThumb && thumbnailTaken) {
      issues.push({
        path: join(dir, tbThumb),
        reason: message('import.thumbnailNameTaken'),
        severity: 'warning',
      })
    } else if (tbThumb) {
      const srcThumb = join(dir, tbThumb)
      const dstThumb = join(libraryDir, tbThumb)
      try {
        // not recorded: the imported poster is library content, like its media.
        if (srcThumb !== dstThumb) {
          assertImportDestination(dstThumb, destinationNames)
          await copyFileNoOverwrite(srcThumb, dstThumb, { hardLinks, signal })
          copied.push(dstThumb)
          destinationNames.add(portableFilenameIdentity(basename(dstThumb)))
        }
        thumbnailFilename = tbThumb
      } catch (err) {
        log.error('import thumbnail copy failed', {
          path: srcThumb,
          error: describeError(err),
        })
        issues.push({
          path: srcThumb,
          reason: message('import.thumbnailCopyFailed'),
          severity: 'error',
        })
      }
    }

    // No other file action runs during this turn, so the admission above still
    // holds; the batch's inbox order is allocated at publication below.
    const tape = tapeFromSidecar(sidecar, {
      id: nanoid(10),
      sourceUrl,
      mediaFilename,
      sidecarFilename: `${mediaStem}.json`,
      thumbnailFilename,
      order: frontOrders(session.getTapes().filter((t) => !t.archivedAtUtc).map((t) => t.order), 1)[0]!,
      nowUtc: nowUtcIso(),
    })
    session.upsertTape(tape)
    imported.push(tape)
  }

  if (imported.length > 0) {
    // Allocate the final block at publication, after all copy waits. URL
    // additions may have joined the inbox while these files were copied.
    const importedIds = new Set(imported.map((tape) => tape.id))
    const currentInbox = session.getTapes().filter((tape) => !tape.archivedAtUtc)
    const members = imported.map((tape) => session.getTape(tape.id)).filter((tape): tape is Tape => !!tape && !tape.archivedAtUtc)
    const orders = frontOrders(currentInbox.filter((tape) => !importedIds.has(tape.id)).map((tape) => tape.order), members.length)
    members.forEach((tape, index) => session.upsertTape({ ...tape, order: orders[index]! }))
    // The receipt describes what this import accepted; later removal must not
    // erase that outcome, while its assigned order reflects publication time.
    imported.splice(0, imported.length, ...imported.map((tape) => session.getTape(tape.id) ?? tape))
    // The copied files are in the library; commit their rows before reporting,
    // so a crash now cannot leave them unlisted and blocking a re-import. The rows
    // are in the library either way; a failed write is the session store's to
    // retry and report, and the window must still learn about them.
    await session.persistNow()
    // A window can list and organize these rows while the save waits. Announce
    // their current values, leaving out any tape already removed in that time.
    const current = imported
      .map((tape) => session.getTape(tape.id))
      .filter((tape): tape is Tape => tape !== undefined)
    if (current.length > 0) emit('tapes:added', current)
  }
  for (const path of unsupportedSelectedPaths(paths, claimedCompanionPaths)) {
    issues.push({
      path,
      reason: message('import.unsupportedFile'),
      severity: 'warning',
    })
  }

  log.info('library:import', { imported: imported.length, issues: issues.length })
  return { imported, issues }
}

/** The catalog owns source and portable filename admission, even for missing files. */
function importBundleConflict(source: SourceRef, names: readonly string[], path: string): ImportIssue | null {
  if (session.sourceOwner(source)) {
    return { path, reason: message(ALREADY_IN_LIBRARY), severity: 'information' }
  }
  const clash = names.find((name) => session.filenameOwner(name))
  return clash ? { path, reason: message('import.nameTaken', { name: clash }), severity: 'warning' } : null
}

/**
 * Rename a downloaded tape's media, sidecar and thumbnail together. Media and
 * thumbnail names are published with hard links where supported, whose cost does
 * not grow with the video; the copy fallback scales with file size. The sidecar
 * is rewritten with the new names. Quitting aborts it before the catalog commit,
 * which rolls the new names back.
 */
async function renameTape(tapeId: string, name: string, libraryDir: string, signal: AbortSignal): Promise<Tape> {
  const tape = session.getTape(tapeId)
  if (!tape) throw new Error(`Tape not found: ${tapeId}`)
  if (!tape.filename || !tape.sidecarFilename) {
    throw new Error('Tape has no files on disk yet')
  }
  const plan = planRename(
    {
      name: tape.name,
      filename: tape.filename,
      sidecarFilename: tape.sidecarFilename,
      thumbnailFilename: tape.thumbnailFilename,
    },
    name,
  )
  if (plan.status === 'error') throw new UserFacingError('invalid', plan.message)
  if (plan.status === 'noop') return tape

  for (const item of plan.items) {
    const owner = session.filenameOwner(item.fresh, tape.id)
    if (owner) throw new UserFacingError('conflict', message('rename.failed'), {
      cause: new Error(`Rename destination ${item.fresh} belongs to catalog tape ${owner}.`),
    })
  }
  const { cleanName } = plan
  const p = (rel: string) => join(libraryDir, rel)
  const nowUtc = nowUtcIso()

  // Resolve the plan while keeping every old file until the durable catalog
  // commits. A portable-equivalent spelling change keeps the existing
  // physical filename (the only crash-safe representation on case-insensitive
  // filesystems) while still applying the requested display name.
  const items = await Promise.all(plan.items.map(async (it) => {
    const old = p(it.old)
    const equivalent = portableFilenameIdentity(it.fresh) === portableFilenameIdentity(it.old)
    return {
      artifact: it.artifact,
      finalName: equivalent ? it.old : it.fresh,
      old,
      fresh: p(it.fresh),
      equivalent,
    }
  }))

  const publishing = items.filter((item) => !item.equivalent)
  for (const it of publishing) await assertMissing(it.fresh)

  const byArtifact = (artifact: (typeof items)[number]['artifact']) =>
    items.find((item) => item.artifact === artifact)
  const mediaName = byArtifact('media')!.finalName
  const sidecarName = byArtifact('sidecar')!.finalName
  const thumbnailName = byArtifact('thumbnail')?.finalName ?? null
  const sidecarItem = byArtifact('sidecar')!
  const sidecar = await readSidecarFile(sidecarItem.old)
  const tb = sidecarNamespace(sidecar, tape)
  tb['name'] = cleanName
  tb['renamedAtUtc'] = nowUtc
  tb['mediaFilename'] = mediaName
  tb['thumbnailFilename'] = thumbnailName
  sidecar['tapebox'] = tb

  const renamed: session.RenameFields = {
    filename: mediaName,
    sidecarFilename: sidecarName,
    thumbnailFilename: thumbnailName,
    name: cleanName,
    renamedAtUtc: nowUtc,
  }

  // Build and exclusively publish every genuinely new destination while the old
  // files remain intact. Until catalog.json commits, the new files are
  // rollback-only and the persisted row still resolves every old file.
  const done: string[] = []
  const rollbackBeforeCatalogCommit = async (initiatingError: unknown): Promise<never> => {
    try {
      await unlinkFiles(done)
    } catch (cleanupError) {
      throw new AggregateError(
        [initiatingError, cleanupError],
        `Rename failed before the catalog commit and destination rollback was incomplete. ` +
          `Destinations: ${done.join(', ')}.`,
      )
    }
    throw initiatingError
  }

  try {
    for (const it of publishing) {
      if (it.artifact === 'sidecar') {
        // not recorded: the sidecar is library content, transient app-owned until
        // exported (developer classification); the tape's catalog row records instead.
        // The renamed sidecar replaces the old one, so it keeps what a replace keeps.
        const bytes = serializeStoreJson(sidecar, SIDECAR_JSON)
        await writeFileAtomicNoOverwriteVia(it.fresh, (temp) => writeFile(temp, bytes), (await stat(it.old)).mode & 0o777)
        done.push(it.fresh)
      } else {
        // not recorded: the tape's media and poster gain a second name inside the
        // library; nothing the user authored is created.
        await linkOrCopyNoOverwrite(it.old, it.fresh, signal)
        done.push(it.fresh)
      }
      signal.throwIfAborted()
    }
  } catch (err) {
    await rollbackBeforeCatalogCommit(err)
  }

  const committed = await session.renameTapeDurably(tapeId, renamed).catch(rollbackBeforeCatalogCommit)
  emit('tapes:updated', committed)

  // The durable catalog is the commit point. Equivalent-name sidecars retain
  // their old physical path and are rewritten only now; genuinely renamed old
  // files become obsolete only now. Any failure is an explicit partial success:
  // catalog and renderer still name a complete, existing bundle.
  const postCommitErrors: unknown[] = []
  if (sidecarItem.equivalent) {
    try {
      await writeSidecar(sidecarItem.old, sidecar)
    } catch (sidecarError) {
      postCommitErrors.push(
        new AggregateError([sidecarError], `Committed sidecar could not be updated at ${sidecarItem.old}.`),
      )
    }
  }
  const obsolete = publishing.map((item) => item.old)
  try {
    await unlinkFiles(obsolete.filter((path) => !session.filenameOwner(basename(path), tapeId)))
  } catch (cleanupError) {
    postCommitErrors.push(cleanupError)
  }
  if (postCommitErrors.length > 0) {
    const diagnostic = new AggregateError(
      postCommitErrors,
      `Rename committed and the catalog points to the new bundle, but post-commit sidecar/source cleanup was incomplete. ` +
        `Old/sidecar paths: ${[...obsolete, sidecarItem.old].join(', ')}.`,
    )
    throw new UserFacingError(
      'conflict',
      message('errors.renameOldFilesKept'),
      { cause: diagnostic },
    )
  }
  log.info('renamed', { tapeId: tape.id, name: cleanName })
  return session.getTape(tapeId) ?? committed
}

/**
 * Remove tapes from the library. With deleteFiles, each tape's files are trashed
 * (or deleted, per the Trash setting) and its download leftovers swept; otherwise
 * only the library entries go. An in-flight download is stopped first so we never
 * race yt-dlp's writes, and no download starts for a tape being removed.
 *
 * library:remove takes its own turn; Export's "delete from app" copies the
 * files out, then removes the tape within its turn through {@link removeTapesFrom}.
 */
export async function removeTapes(
  tapeIds: string[],
  deleteFiles: boolean,
): Promise<{ removed: string[]; failed: string[] }> {
  const ids = new Set(tapeIds)
  // Before anything is cancelled, so a finishing job cannot start another of
  // these. Downloads stop before the turn is taken: a stopping job may need a
  // turn of its own to add its finished download.
  const release = queue.holdFromScheduling(ids)
  try {
    for (const id of ids) if (queue.isActive(id)) await queue.cancel(id)
    return await withLibraryTurn((libraryDir) => removeTapesFrom(libraryDir, [...ids], deleteFiles))
  } finally {
    release()
  }
}

/** Remove tapes at the caller's library turn; none of them has a running download. */
export async function removeTapesFrom(
  libraryDir: string,
  tapeIds: string[],
  deleteFiles: boolean,
): Promise<{ removed: string[]; failed: string[] }> {
  const settings = getSettings()
  const removed: string[] = []
  const failed: string[] = []
  const selected = tapeIds.map((id) => session.getTape(id)).filter((tape): tape is Tape => !!tape)
  // Enumerate once, retaining only candidates for the selected namespaces.
  const candidates = new Map<string, string[]>()
  if (deleteFiles && selected.length) {
    const stems = new Map(selected.map((tape) => [portableFilenameIdentity(tape.id), tape.id]))
    try {
      for (const name of await readdir(libraryDir)) {
        const identity = portableFilenameIdentity(name)
        for (let at = identity.indexOf('.'); at !== -1; at = identity.indexOf('.', at + 1)) {
          const id = stems.get(identity.slice(0, at))
          if (id === undefined) continue
          let names = candidates.get(id)
          if (!names) candidates.set(id, names = [])
          names.push(name)
        }
      }
    } catch (error) {
      log.error('library removal listing failed', { error: describeError(error) })
      failed.push(...selected.map((tape) => tape.id))
      return { removed, failed }
    }
  }
  for (const tape of selected) {
    if (deleteFiles) {
      try {
        if (tape.sidecarFilename) await refuseNewerSidecar(join(libraryDir, tape.sidecarFilename))
        await discardTapeFiles(libraryDir, tape, settings.trashOnRemove, candidates.get(tape.id) ?? [])
      } catch (err) {
        log.error('library removal failed', { tapeId: tape.id, error: describeError(err) })
        failed.push(tape.id)
        continue
      }
    }
    removed.push(tape.id)
  }

  if (removed.length > 0) {
    session.removeTapes(removed)
    // Files are already discarded; commit the removal before reporting it, so a
    // crash now cannot bring back rows that point at trashed files. The removal
    // stands either way; a failed write is the session store's to retry and report.
    await session.persistNow()
    emit('tapes:removed', { tapeIds: removed })
  }
  return { removed, failed }
}

/**
 * A sidecar from a newer TapeBox may name files this version does not know, so
 * its tape keeps its files. A damaged or missing sidecar does not stop the
 * removal: the user asked for the files to go, and the Trash setting applies.
 */
async function refuseNewerSidecar(path: string): Promise<void> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return }
  const found = parseStoreJson(text, FORMAT_VERSIONS.sidecar)
  if (found.status === 'newer') throw new NewerFormatError(path, found.version, FORMAT_VERSIONS.sidecar)
}

/**
 * Discard a tape's files: the ones its row names, then everything else under its
 * id stem — what a download left before its commit, including a finished bundle
 * the catalog never named. yt-dlp's in-progress fragments are incomplete junk and
 * are deleted outright; every other file follows the Trash setting. A name
 * another tape tracks is never touched.
 */
async function discardTapeFiles(libraryDir: string, tape: Tape, toTrash: boolean, candidates: readonly string[]): Promise<void> {
  const tracked = new Set<string>()
  for (const field of TRACKED_FILENAME_FIELDS) {
    const name = tape[field]
    if (name === null) continue
    tracked.add(portableFilenameIdentity(name))
    if (!session.filenameOwner(name, tape.id)) await discardFile(join(libraryDir, name), toTrash)
  }
  for (const name of candidates) {
    if (tracked.has(portableFilenameIdentity(name)) || session.filenameOwner(name, tape.id)) continue
    const unfinished = name.endsWith('.part') || name.endsWith('.ytdl') || /\.frag\d*$/.test(name)
    await discardFile(join(libraryDir, name), unfinished ? false : toTrash)
  }
}

/**
 * Discard one file on removal: move it to the OS Trash (recoverable) when
 * trashing is on, else delete it permanently. A missing file is a no-op either way.
 * A real failure THROWS (it is not swallowed) so the caller can keep the catalog
 * entry rather than claim a removal that actually left the files behind.
 */
async function discardFile(path: string, toTrash: boolean): Promise<void> {
  if (!toTrash) {
    try {
      await unlink(path)
    } catch (err) {
      // Already gone is success; any other failure is real and propagates.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return
  }
  if (!(await fileExists(path))) return
  await shell.trashItem(path)
}

function assertImportDestination(path: string, names: ReadonlySet<string>): void {
  if (names.has(portableFilenameIdentity(basename(path)))) throw new Error(`Target already exists (case-insensitive): ${path}`)
}

async function assertMissing(path: string): Promise<void> {
  if (await portableSiblingExists(path)) {
    throw new Error(`Target already exists (case-insensitive): ${path}`)
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}
