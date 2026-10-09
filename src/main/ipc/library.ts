import { access, constants, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { shell } from 'electron'
import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
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
import { readSidecarFile, SIDECAR_JSON, writeSidecar } from '@main/core/sidecar'
import { portableFilenameIdentity } from '@main/core/filename'
import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import { unsupportedSelectedPaths } from '@main/core/import-selection'
import * as queue from '@main/queue/manager'
import { runCancellable } from '@main/work-registry'
import { withLibraryWrite } from '@main/library-writes'
import { librarySourceIndex } from '@shared/source-identity'
import { downloadThumbnail, probe } from '@main/services/ytdlp'
import { saveThumbnailJpeg } from '@main/services/ffmpeg'
import { nowUtcIso } from '@shared/utc'
import { frontOrders } from '@shared/order'
import { SidecarTapeBoxSchema, TRACKED_FILENAME_FIELDS, trackedFilenameIdentities, type Tape } from '@shared/domain'
import type { ImportIssue, ImportResult, RefreshedMetadata, SidecarRaw } from '@shared/ipc-contract'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'
import { ALREADY_IN_LIBRARY } from '@shared/import-issues'

const tapeWrites = new Set<string>()

function claimTapeWrite(id: string): (() => void) | null {
  if (tapeWrites.has(id)) return null
  tapeWrites.add(id)
  return () => { tapeWrites.delete(id) }
}

async function withTapeWrite<T>(id: string, work: () => Promise<T>): Promise<T> {
  const release = claimTapeWrite(id)
  if (!release) throw new UserFacingError('refused', message('errors.tapeBusy'))
  try { return await work() } finally { release() }
}

export function registerLibraryHandlers(): void {
  session.onCatalogSaveFailure(() => emit('library:saveFailed', null))

  handle('library:list', async () => session.getTapes())

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
      emit('tapes:updated', updated)
    })
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
      emit('tapes:updated', updated)
    })
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
    const { failed, busy } = await removeTapes(tapeIds, deleteFiles)
    // Tapes whose files couldn't be discarded are KEPT (not removed from the list);
    // surface the failure so the user is never told a removal succeeded while the
    // files (and the catalog entry) actually remain. A busy tape kept its files too,
    // but when no files were to go, it is only busy.
    const kept = failed.length + (deleteFiles ? busy.length : 0)
    if (kept > 0) {
      throw new UserFacingError('conflict', message('errors.removeFilesKept', { count: kept }))
    }
    if (busy.length > 0) throw new UserFacingError('refused', message('errors.tapeBusy'))
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
      const error = await shell.openPath(full) // '' on success, message on failure
      if (error) throw new Error(error)
      return
    }
    await openExternalPlayer(player, full)
  })

  handle('library:rename', ({ tapeId, name }) => runCancellable((signal) =>
    withLibraryWrite((libraryDir) => withTapeWrite(tapeId, () => renameTape(tapeId, name, libraryDir, signal)))))

  handle('library:probeMetadata', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)

    // One deliberate re-probe, read-only. The probe's own idle watchdog guards a
    // stall, and it is never auto-retried — re-hammering the source is the user's
    // call. Nothing is written here: the caller reviews this and decides.
    const result = await runCancellable((signal) => probe(tape.id, tape.sourceUrl, signal))
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

  // Writes the sidecar and may save a poster into the library, so it holds a write claim.
  handle('library:applyMetadata', ({ tapeId, metadata }) => runCancellable((signal) =>
    withLibraryWrite((dir) => withTapeWrite(tapeId, () => applyMetadata(tapeId, metadata, dir, signal)))))

  // Sidecar-driven import: the whole selection arrives here so this filesystem-owning
  // boundary can tell referenced bundle companions from unsupported extras. One
  // sidecar = one tape, so a duplicate is reported once, not once per selected file.
  handle('library:import', ({ paths }) => runCancellable((signal) =>
    withLibraryWrite((libraryDir) => importBundles(paths, libraryDir, signal))))
}

async function applyMetadata(tapeId: string, metadata: RefreshedMetadata, dir: string, signal: AbortSignal): Promise<Tape> {
  const existing = session.getTape(tapeId)
  if (!existing) throw new Error(`Tape not found: ${tapeId}`)
  if (queue.isActive(tapeId)) throw new UserFacingError('refused', message('errors.tapeBusy'))
  const tape = structuredClone(existing)
  const assertCurrent = (): Tape => {
    signal.throwIfAborted()
    const current = session.getTape(tapeId)
    const fields = ['sourceUrl', 'state', 'filename', 'sidecarFilename', 'thumbnailFilename', 'title', 'uploader', 'probedAtUtc', 'name'] as const
    if (!current || fields.some((key) => current[key] !== tape[key])) {
      throw new UserFacingError('refused', message('refresh.applyStale'))
    }
    return current
  }
  // Refuse a protected sidecar before attempting its optional poster backfill.
  if (tape.sidecarFilename) await readSidecarFile(join(dir, tape.sidecarFilename))
  assertCurrent()

  // Backfill a local poster for a downloaded tape that has none — e.g. one
  // downloaded before thumbnails were saved locally. Best-effort: the catalog
  // metadata the user reviewed must still apply even if the fetch fails. Routed
  // through the same image gate as a fresh download.
  let thumbnailFilename = tape.thumbnailFilename
  if (thumbnailFilename === null && tape.filename) {
    const stem = tape.filename.slice(0, -extname(tape.filename).length)
    try {
      if (await posterStemFree(tape, dir, stem)) {
        assertCurrent()
        const raw = await downloadThumbnail(tape.id, tape.sourceUrl, dir, stem, signal)
        assertCurrent()
        thumbnailFilename = raw ? await saveThumbnailJpeg(tape.id, raw, dir, stem, signal) : null
      } else {
        log.warn('thumbnail backfill skipped; another file has the poster name', { tapeId, stem })
      }
    } catch (err) {
      log.warn('thumbnail backfill failed', { tapeId, error: describeError(err) })
    }
  }
  assertCurrent()

  // The sidecar is the bundle's own record: export carries it and import reads
  // its title, uploader and poster back. So it takes everything the catalog is
  // about to hold, and it is written before the catalog, so a failed write leaves
  // the catalog as it was rather than the two disagreeing. A poster fetched for
  // it stays in the library under the tape's own stem, for the next Apply.
  if (tape.sidecarFilename) {
    await writeRefreshedSidecar(join(dir, tape.sidecarFilename), metadata, thumbnailFilename, assertCurrent)
  }

  // Once the sidecar has committed, Apply finishes with its catalog commit even if
  // it is cancelled or the app is quitting, so the two never disagree; the tape
  // write claim keeps the fields checked above unchanged. Without a sidecar there
  // was no await since the last check.
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
 * the tape's own: yt-dlp writes the raw image as `<stem>.<ext>` and the image gate
 * replaces `<stem>.jpg`. No other tape may track a name with this stem, and no
 * entry in the library may spell the stem differently (storage-path-conventions);
 * an entry spelled exactly is the tape's own, such as a poster an earlier Apply
 * left for the next one.
 */
async function posterStemFree(tape: Tape, dir: string, stem: string): Promise<boolean> {
  const identity = portableFilenameIdentity(stem)
  const stemOf = (name: string) => name.slice(0, name.length - extname(name).length)
  for (const other of session.getTapes()) {
    if (other.id === tape.id) continue
    for (const field of TRACKED_FILENAME_FIELDS) {
      const name = other[field]
      if (name !== null && portableFilenameIdentity(stemOf(name)) === identity) return false
    }
  }
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
  assertCurrent: () => Tape,
): Promise<void> {
  const sidecar = await readSidecarFile(path)
  let changed = false
  const fields = { title: metadata.title, uploader: metadata.uploader, description: metadata.description }
  for (const [key, value] of Object.entries(fields)) {
    if ((sidecar[key] ?? null) === value) continue
    sidecar[key] = value
    changed = true
  }
  const tb = sidecar['tapebox']
  if (tb && typeof tb === 'object' && (tb as Record<string, unknown>)['thumbnailFilename'] !== thumbnailFilename) {
    sidecar['tapebox'] = SidecarTapeBoxSchema.parse({ ...tb, thumbnailFilename })
    changed = true
  }
  if (!changed) return
  assertCurrent()
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
  const imported: Tape[] = []
  const issues: ImportIssue[] = []
  const sidecarPaths = paths.filter((path) => extname(path).toLowerCase() === '.json')
  const claimedCompanionPaths: string[] = []

  // Reserve a front-of-inbox order window for the whole selection up front, then
  // hand them out one per successful import, so the batch lands on top in the
  // order chosen even when some entries are rejected mid-loop.
  const inbox = session.getTapes().filter((t) => !t.archivedAtUtc)
  const orderWindow = frontOrders(inbox.map((t) => t.order), sidecarPaths.length)
  let orderCursor = 0

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

    const existing = librarySourceIndex(session.getTapes()).has({
      url: sourceUrl,
      extractor: typeof sidecar['extractor'] === 'string' ? sidecar['extractor'] : null,
      sourceId: typeof sidecar['id'] === 'string' ? sidecar['id'] : null,
    })
    if (existing) {
      issues.push({ path: sidecarPath, reason: message(ALREADY_IN_LIBRARY), severity: 'information' })
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
    // consistent (media + sidecar share a stem) regardless of the sidecar's own name.
    const mediaStem = mediaFilename.slice(0, -extname(mediaFilename).length)

    // The catalog tracks each library filename once. A name another tape already
    // owns is refused here, before anything is copied: the disk alone cannot tell
    // (the other tape's file may be missing, or this bundle may already sit in the
    // library folder), and a row that broke the rule would fail every later save.
    const tracked = trackedFilenameIdentities(session.getTapes())
    const clash = [mediaFilename, `${mediaStem}.json`].find((name) => tracked.has(portableFilenameIdentity(name)))
    if (clash) {
      issues.push({
        path: sidecarPath,
        reason: message('import.nameTaken', { name: clash }),
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
        await assertMissing(targetMedia)
        await copyFileNoOverwrite(srcMedia, targetMedia, { hardLinks, signal })
        copied.push(targetMedia)
      }
      if (sidecarPath !== targetSidecar) {
        await assertMissing(targetSidecar)
        await copyFileNoOverwrite(sidecarPath, targetSidecar, { hardLinks, signal })
        copied.push(targetSidecar)
      }
    } catch (err) {
      try {
        await unlinkFiles(copied)
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
    if (tbThumb && tracked.has(portableFilenameIdentity(tbThumb))) {
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
          await assertMissing(dstThumb)
          await copyFileNoOverwrite(srcThumb, dstThumb, { hardLinks, signal })
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

    const tape = tapeFromSidecar(sidecar, {
      id: nanoid(10),
      sourceUrl,
      mediaFilename,
      sidecarFilename: `${mediaStem}.json`,
      thumbnailFilename,
      order: orderWindow[orderCursor++],
      nowUtc: nowUtcIso(),
    })
    session.upsertTape(tape)
    imported.push(tape)
  }

  if (imported.length > 0) {
    // The copied files are in the library; commit their rows before reporting,
    // so a crash now cannot leave them unlisted and blocking a re-import. The rows
    // are in the library either way; a failed write is the session store's to
    // retry and report, and the window must still learn about them.
    await session.persistNow()
    emit('tapes:added', imported)
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

/**
 * Rename a downloaded tape's media, sidecar and thumbnail together. New names are
 * published with hard links (a copy only where the library cannot link), so the
 * cost does not grow with the video. Quitting aborts it before the catalog commit,
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
  const tb = (sidecar['tapebox'] as Record<string, unknown> | undefined) ?? {}
  tb['name'] = cleanName
  tb['renamedAtUtc'] = nowUtc
  tb['mediaFilename'] = mediaName
  tb['thumbnailFilename'] = thumbnailName
  sidecar['tapebox'] = SidecarTapeBoxSchema.parse(tb)

  const updated = {
    ...tape,
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

  try {
    await session.renameTapeDurably(updated)
  } catch (catalogError) {
    await rollbackBeforeCatalogCommit(catalogError)
  }
  emit('tapes:updated', updated)

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
    await unlinkFiles(obsolete)
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
  return updated
}

/**
 * Remove tapes from the library. With deleteFiles, each tape's files are trashed
 * (or deleted, per the Trash setting) and its download leftovers swept; otherwise
 * only the library entries go. An in-flight download is stopped first so we never
 * race yt-dlp's writes, and no download starts for a tape being removed.
 *
 * Shared by library:remove and Export's "delete from app" (export copies the
 * files out, then calls this to take the tape out of the library). A tape another
 * operation is changing is reported busy and kept.
 */
export function removeTapes(
  tapeIds: string[],
  deleteFiles: boolean,
): Promise<{ removed: string[]; failed: string[]; busy: string[] }> {
  return withLibraryWrite((libraryDir) => removeTapesFrom(libraryDir, tapeIds, deleteFiles))
}

async function removeTapesFrom(
  libraryDir: string,
  tapeIds: string[],
  deleteFiles: boolean,
): Promise<{ removed: string[]; failed: string[]; busy: string[] }> {
  const settings = getSettings()
  const removed: string[] = []
  const failed: string[] = []
  const busy: string[] = []
  const ids = new Set(tapeIds)
  // Before anything is cancelled, so a finishing job cannot start another of these.
  const releases: Array<() => void> = [queue.holdFromScheduling(ids)]

  try {
    for (const id of ids) {
      if (!session.getTape(id)) continue
      const release = claimTapeWrite(id)
      if (!release) { busy.push(id); continue }
      releases.push(release)

      if (queue.isActive(id)) {
        await queue.cancel(id)
      }
      // Reread once the job has settled: a download can finalize and commit while
      // it is being cancelled, naming files the earlier row did not.
      const tape = session.getTape(id)
      if (!tape) continue

      if (deleteFiles) {
        try {
          if (tape.sidecarFilename) await refuseNewerSidecar(join(libraryDir, tape.sidecarFilename))
          const others = session.getTapes().filter((other) => other.id !== tape.id)
          await discardTapeFiles(libraryDir, tape, others, settings.trashOnRemove)
        } catch (err) {
          // The files couldn't be discarded — keep the catalog entry so the tape never
          // vanishes from the list while its files are left orphaned on disk.
          log.error('library removal failed', { tapeId: id, error: describeError(err) })
          failed.push(id)
          continue
        }
      }
      removed.push(id)
    }

    if (removed.length > 0) {
      session.removeTapes(removed)
      // Files are already discarded; commit the removal before reporting it, so a
      // crash now cannot bring back rows that point at trashed files. The removal
      // stands either way; a failed write is the session store's to retry and report.
      await session.persistNow()
      emit('tapes:removed', { tapeIds: removed })
    }
    return { removed, failed, busy }
  } finally {
    for (const release of releases.reverse()) release()
  }
}

/**
 * A sidecar from a newer TapeBox may name files this version does not know, so
 * its tape keeps its files. A damaged or missing sidecar does not stop the
 * removal: the user asked for the files to go, and the Trash setting applies.
 */
async function refuseNewerSidecar(path: string): Promise<void> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return }
  const found = parseStoreJson(text, FORMAT_VERSIONS.sidecar, true)
  if (found.status === 'newer') throw new NewerFormatError(path, found.version, FORMAT_VERSIONS.sidecar)
}

/**
 * Discard a tape's files: the ones its row names, then everything else under its
 * id stem — what a download left before its commit, including a finished bundle
 * the catalog never named. yt-dlp's in-progress fragments are incomplete junk and
 * are deleted outright; every other file follows the Trash setting. A name
 * another tape tracks is never touched.
 */
async function discardTapeFiles(libraryDir: string, tape: Tape, others: readonly Tape[], toTrash: boolean): Promise<void> {
  for (const field of TRACKED_FILENAME_FIELDS) {
    const name = tape[field]
    if (name !== null) await discardFile(join(libraryDir, name), toTrash)
  }
  // The tape's own names are already discarded above.
  const taken = trackedFilenameIdentities([...others, tape])
  for (const name of await readdir(libraryDir)) {
    if (!name.startsWith(`${tape.id}.`) || taken.has(portableFilenameIdentity(name))) continue
    if (name.endsWith('.part') || name.endsWith('.ytdl') || /\.frag\d*$/.test(name)) {
      await unlink(join(libraryDir, name)).catch(() => {})
    } else {
      await discardFile(join(libraryDir, name), toTrash)
    }
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

async function assertMissing(path: string): Promise<void> {
  if (await portableSiblingExists(path)) {
    throw new Error(`Target already exists (case-insensitive): ${path}`)
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
