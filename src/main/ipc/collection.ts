import { access, constants, mkdir, readFile, readdir, rm, rmdir, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { shell } from 'electron'
import { handle } from './handle'
import { emit, sendTo } from './events'
import * as session from '@main/store/session'
import { getCollectionDir, getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import {
  copyFileNoOverwrite,
  directorySupportsHardLinks,
  linkOrCopyNoOverwrite,
  unlinkFiles,
} from '@main/io/atomic-file'
import { openExternalPlayer } from '@main/io/external-player'
import { FORMAT_VERSIONS, NewerFormatError, parseStoreJson } from '@main/io/format-version'
import { portableSiblingExists } from '@main/io/portable-directory'
import { planRename } from '@main/core/rename-plan'
import { collectionSidecar, readSidecarFile, writeSidecar } from '@main/core/sidecar'
import { reserveTapeId } from '@main/core/stem'
import { areaDir, tapeDir, tapeFile } from '@main/paths'
import { portableFilenameIdentity } from '@main/core/filename'
import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import { unsupportedSelectedPaths } from '@main/core/import-selection'
import * as queue from '@main/queue/manager'
import { cancelWork, runCancellable } from '@main/work-registry'
import { withCollectionTurn } from '@main/collection-writes'
import { type SourceRef } from '@shared/source-identity'
import { downloadThumbnail, probe } from '@main/services/ytdlp'
import { saveThumbnailJpeg } from '@main/services/ffmpeg'
import { nowUtcIso } from '@shared/utc'
import { TAPE_FILE, type Tape } from '@shared/domain'
import type { ImportIssue, ImportResult, RefreshedMetadata, SidecarRaw } from '@shared/ipc-contract'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'
import { ALREADY_IN_COLLECTION } from '@shared/import-issues'

const PASSIVE_MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.mpg', '.mpeg', '.ogv', '.flv', '.wmv', '.3gp', '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.aiff'])

/** Tell the window where these tapes are now, after a move that may have
 *  stopped partway. */
function emitCurrent(tapeIds: readonly string[]): void {
  const current = tapeIds.map((id) => session.getTape(id)).filter((tape): tape is Tape => !!tape)
  if (current.length > 0) emit('tapes:updatedMany', current)
}

export function registerCollectionHandlers(): void {
  session.onCollectionSaveFailure(() => emit('collection:saveFailed', null))

  // The catalog goes as this subscription's first event, sent in the same turn
  // as any later change would be, so the window needs no second source.
  handle('collection:subscribe', async (_req, event) => {
    sendTo(event.sender, 'collection:current', { tapes: session.getTapes(), boxes: session.getBoxes() })
  })

  // Shelving and taking back move tape folders, so they take a collection turn:
  // no rename, export or poster refresh is working in a folder as it moves. A
  // tape still downloading writes into its Inbox folder, so only a downloaded
  // tape with no job shelves; shelved tapes start on top of Loose tapes, in the
  // order they were selected.
  handle('collection:shelve', ({ tapeIds }) => withCollectionTurn(async () => {
    const shelvable = tapeIds.filter((id) => session.getTape(id)?.state === 'downloaded' && !queue.isActive(id))
    if (shelvable.length === 0) return
    try {
      await session.shelveTapes(shelvable)
    } finally {
      emitCurrent(shelvable)
    }
  }))

  // Back to Inbox drops the tape's Shelf organization (its box and place); the
  // Inbox shows it by when it was added.
  handle('collection:unshelve', ({ tapeIds }) => withCollectionTurn(async () => {
    try {
      await session.unshelveTapes(tapeIds)
    } finally {
      emitCurrent(tapeIds)
    }
  }))

  // Reindex one list (the inbox, a box, or Loose tapes) to the caller's sequence after
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
  handle('collection:remove', ({ tapeIds, deleteFiles }) => runCancellable(async () => {
    const { failed } = await removeTapes(tapeIds, deleteFiles)
    // Tapes whose files couldn't be discarded are KEPT (not removed from the list);
    // surface the failure so the user is never told a removal succeeded while the
    // files (and the catalog entry) actually remain.
    if (failed.length > 0) {
      throw new UserFacingError('conflict', message('errors.removeFilesKept', { count: failed.length }))
    }
  }))

  handle('collection:getSidecar', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape || !tape.sidecarFilename) {
      throw new Error(`Sidecar not available for tape ${tapeId}`)
    }
    return await readSidecarFile(tapeFile(getCollectionDir(), tape, tape.sidecarFilename)) as SidecarRaw
  })

  handle('collection:reveal', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape?.filename) throw new Error('No file to reveal for this tape')
    shell.showItemInFolder(tapeFile(getCollectionDir(), tape, tape.filename))
  })

  handle('collection:playExternal', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape?.filename) throw new Error('No file to play for this tape')
    const full = tapeFile(getCollectionDir(), tape, tape.filename)
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

  handle('collection:rename', ({ tapeId, name }) => runCancellable((signal) =>
    withCollectionTurn((libraryDir) => renameTape(tapeId, name, libraryDir, signal))))

  handle('collection:probeMetadata', async ({ tapeId, requestId }) => {
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

  handle('collection:cancelMetadataProbe', async ({ requestId }) => {
    cancelWork(`metadata-probe:${requestId}`)
  })

  // Writes the sidecar and may save a poster into the library, so it takes a library turn.
  handle('collection:applyMetadata', ({ tapeId, metadata }) => runCancellable((signal) =>
    withCollectionTurn((dir) => applyMetadata(tapeId, metadata, dir, signal))))

  // Sidecar-driven import: the whole selection arrives here so this filesystem-owning
  // boundary can tell referenced bundle companions from unsupported extras. One
  // sidecar = one tape, so a duplicate is reported once, not once per selected file.
  handle('collection:import', ({ paths }) => runCancellable((signal) =>
    withCollectionTurn((libraryDir) => importBundles(paths, libraryDir, signal))))
}

async function applyMetadata(tapeId: string, metadata: RefreshedMetadata, libraryDir: string, signal: AbortSignal): Promise<Tape> {
  const existing = session.getTape(tapeId)
  if (!existing) throw new Error(`Tape not found: ${tapeId}`)
  if (queue.isActive(tapeId)) throw new UserFacingError('refused', message('errors.tapeBusy'))
  const tape = structuredClone(existing)
  const dir = tapeDir(libraryDir, tape)
  // Refuse a protected sidecar before attempting its optional poster backfill.
  const sidecar = tape.sidecarFilename ? await readSidecarFile(join(dir, tape.sidecarFilename)) : null

  // Backfill a local poster for a downloaded tape that has none — e.g. one
  // downloaded before thumbnails were saved locally. Best-effort: the catalog
  // metadata the user reviewed must still apply even if the fetch fails. Routed
  // through the same image gate as a fresh download.
  let thumbnailFilename = tape.thumbnailFilename
  // The raw fetch uses a private scratch name in the tape's folder; conversion
  // replaces the literal media-stem JPEG there.
  if (thumbnailFilename === null && tape.filename) {
    const stem = tape.filename.slice(0, -extname(tape.filename).length)
    try {
      if (await posterStemFree(dir, stem)) {
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

  // The sidecar keeps yt-dlp's info, so it takes the refreshed title, uploader
  // and description in yt-dlp's own fields; the catalog alone records the
  // poster. It is written before the catalog, so a failed write leaves the
  // catalog as it was rather than the two disagreeing. A poster fetched for it
  // stays in the tape's folder under its own stem, for the next Apply.
  if (tape.sidecarFilename) {
    await writeRefreshedSidecar(join(dir, tape.sidecarFilename), metadata, sidecar!)
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
 * Whether a poster can be fetched under `stem` in the tape's folder: the image
 * gate replaces the literal `<stem>.jpg`, so no entry there may spell the stem
 * differently (storage-path-conventions); an entry spelled exactly is the
 * tape's own, such as a poster an earlier Apply left for the next one.
 */
async function posterStemFree(dir: string, stem: string): Promise<boolean> {
  const identity = portableFilenameIdentity(stem)
  const stemOf = (name: string) => name.slice(0, name.length - extname(name).length)
  const entries = await readdir(dir)
  return entries.every((name) => stemOf(name) === stem || portableFilenameIdentity(stemOf(name)) !== identity)
}

/**
 * Put accepted metadata into a tape's sidecar: the title, uploader and
 * description in yt-dlp's own fields. A sidecar that already holds every value
 * is left as it is.
 */
async function writeRefreshedSidecar(
  path: string,
  metadata: RefreshedMetadata,
  sidecar: Record<string, unknown>,
): Promise<void> {
  let changed = false
  const fields = { title: metadata.title, uploader: metadata.uploader, description: metadata.description }
  for (const [key, value] of Object.entries(fields)) {
    if ((sidecar[key] ?? null) === value) continue
    sidecar[key] = value
    changed = true
  }
  if (!changed) return
  // not recorded: the sidecar is library-directory content, colocated with binary
  // media, so it is excluded (data-backup conventions) and takes the raw
  // writeJsonAtomic, not the choke point.
  await writeSidecar(path, sidecar)
}

/**
 * Import sidecar-driven bundles into the library. Each bundle gets a new tape
 * folder; its media and poster are each copied once (into a temp that is linked
 * into place where the library supports hard links), and its sidecar is written
 * there as the library keeps it, its catalog fields going to the catalog.
 * Quitting stops the import between chunks, rolling back the bundle in progress.
 */
async function importBundles(paths: string[], libraryDir: string, signal: AbortSignal): Promise<ImportResult> {
  const hardLinks = await directorySupportsHardLinks(libraryDir)
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
    // The catalog owns source admission, even for missing files. Admit the
    // source before awaiting any of the companion-file work.
    if (session.sourceOwner(source)) {
      issues.push({ path: sidecarPath, reason: message(ALREADY_IN_COLLECTION), severity: 'information' })
      continue
    }

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

    // Library names follow the media file's stem so the bundle stays internally
    // consistent regardless of the sidecar's own name. A stem whose sidecar would
    // be the tape's own tape.json takes the tape's id instead, as a download does.
    const id = await reserveTapeId(libraryDir, [...session.getTapes(), ...imported].map((tape) => tape.id))
    const bundleStem = mediaFilename.slice(0, -extname(mediaFilename).length)
    const mediaStem = portableFilenameIdentity(`${bundleStem}.json`) === portableFilenameIdentity(TAPE_FILE) ? id : bundleStem
    const collectionMedia = `${mediaStem}${extname(mediaFilename)}`
    const sidecarFilename = `${mediaStem}.json`
    const folder = tapeDir(libraryDir, { id, shelved: false })
    try {
      // not recorded: import copies a bundle into the library, transient app-owned
      // content until exported (developer classification). The new catalog row,
      // the user's library membership, is what is backed up.
      await mkdir(areaDir(libraryDir, false), { recursive: true })
      await mkdir(folder)
      await copyFileNoOverwrite(srcMedia, join(folder, collectionMedia), { hardLinks, signal })
      await writeSidecar(join(folder, sidecarFilename), collectionSidecar(sidecar))
    } catch (err) {
      try {
        await rm(folder, { recursive: true, force: true })
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
    if (tbThumb && portableFilenameIdentity(tbThumb) !== portableFilenameIdentity(TAPE_FILE)) {
      const srcThumb = join(dir, tbThumb)
      try {
        // not recorded: the imported poster is library content, like its media.
        await copyFileNoOverwrite(srcThumb, join(folder, tbThumb), { hardLinks, signal })
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
    // holds. The Inbox sorts the tape by its own times, the selection's order
    // breaking ties.
    const tape = tapeFromSidecar(sidecar, {
      id,
      sourceUrl,
      mediaFilename: collectionMedia,
      sidecarFilename,
      thumbnailFilename,
      addedIndex: imported.length,
      nowUtc: nowUtcIso(),
    })
    session.upsertTape(tape)
    imported.push(tape)
  }

  if (imported.length > 0) {
    // The receipt describes what this import accepted; later removal must not
    // erase that outcome.
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

  log.info('collection:import', { imported: imported.length, issues: issues.length })
  return { imported, issues }
}

/**
 * Rename a downloaded tape's media, sidecar and thumbnail together, inside its
 * folder. Each new name is published with a hard link where supported, whose
 * cost does not grow with the video; the copy fallback scales with file size.
 * The files' contents stay as they are: the catalog alone records names.
 * Quitting aborts it before the catalog commit, which rolls the new names back.
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

  const { cleanName } = plan
  const p = (rel: string) => tapeFile(libraryDir, tape, rel)
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
      // not recorded: the tape's files gain a second name inside its folder;
      // nothing the user authored is created.
      await linkOrCopyNoOverwrite(it.old, it.fresh, signal)
      done.push(it.fresh)
      signal.throwIfAborted()
    }
  } catch (err) {
    await rollbackBeforeCatalogCommit(err)
  }

  const committed = await session.renameTapeDurably(tapeId, renamed).catch(rollbackBeforeCatalogCommit)
  emit('tapes:updated', committed)

  // The durable catalog is the commit point; genuinely renamed old files
  // become obsolete only now. A failure is an explicit partial success: catalog
  // and renderer still name a complete, existing bundle.
  const obsolete = publishing.map((item) => item.old)
  try {
    await unlinkFiles(obsolete)
  } catch (cleanupError) {
    const diagnostic = new AggregateError(
      [cleanupError],
      `Rename committed and the catalog points to the new bundle, but the old files could not all be removed. ` +
        `Old paths: ${obsolete.join(', ')}.`,
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
    return await withCollectionTurn((libraryDir) => removeTapesFrom(libraryDir, [...ids], deleteFiles))
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
  // No save writes a tape file into a folder while it is discarded.
  await session.releaseTapeFolders(selected.map((tape) => tape.id))
  for (const tape of selected) {
    const dir = tapeDir(libraryDir, tape)
    try {
      if (deleteFiles) {
        if (tape.sidecarFilename) await refuseNewerSidecar(join(dir, tape.sidecarFilename))
        await discardTapeFolder(dir, settings.trashOnRemove)
      } else {
        // The files stay; without its tape.json the folder no longer holds a tape.
        await rm(join(dir, TAPE_FILE), { force: true })
      }
    } catch (err) {
      log.error('library removal failed', { tapeId: tape.id, error: describeError(err) })
      session.keepTapeFolders([tape.id])
      failed.push(tape.id)
      continue
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
 * Discard a tape's folder: what its row names and everything a download left
 * before its commit, including a finished bundle the catalog never named.
 * yt-dlp's in-progress fragments are incomplete junk and are deleted outright;
 * the folder with everything else follows the Trash setting. A missing folder
 * is a no-op. A real failure THROWS (it is not swallowed) so the caller can
 * keep the catalog entry rather than claim a removal that left the files behind.
 */
async function discardTapeFolder(dir: string, toTrash: boolean): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const partial = (name: string) => name.endsWith('.part') || name.endsWith('.ytdl') || /\.frag\d*$/.test(name)
  for (const name of names) if (partial(name)) await unlink(join(dir, name))
  if (!toTrash) {
    await rm(dir, { recursive: true, force: true })
    return
  }
  // An emptied folder has nothing to recover.
  if (names.every(partial)) {
    await rmdir(dir)
    return
  }
  await shell.trashItem(dir)
}

async function assertMissing(path: string): Promise<void> {
  if (await portableSiblingExists(path)) {
    throw new Error(`Target already exists (case-insensitive): ${path}`)
  }
}
