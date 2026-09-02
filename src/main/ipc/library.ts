import { access, constants, copyFile, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { getLibraryDir, getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { describeError, errorMessage } from '@shared/error'
import { writeJsonAtomic } from '@main/io/atomic-json'
import {
  claimFile,
  publishFileNoOverwrite,
  unlinkClaimedFiles,
  writeFileAtomicNoOverwriteVia,
  type FileClaim,
} from '@main/io/atomic-file'
import { portableSiblingExists, type AllowedPortableDirectoryEntry } from '@main/io/portable-directory'
import { planRename } from '@main/core/rename-plan'
import { portableFilenameIdentity } from '@main/core/filename'
import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import { unsupportedSelectedPaths } from '@main/core/import-selection'
import * as queue from '@main/queue/manager'
import { clearPartials, downloadThumbnail, probe } from '@main/services/ytdlp'
import { saveThumbnailJpeg } from '@main/services/ffmpeg'
import { nowUtcIso } from '@shared/utc'
import { frontOrders } from '@shared/order'
import { SidecarTapeBoxSchema, type Tape } from '@shared/domain'
import type { ImportIssue, SidecarRaw } from '@shared/ipc-contract'

export function registerLibraryHandlers(): void {
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

  handle('library:remove', async ({ tapeIds, deleteFiles }) => {
    const { failed } = await removeTapes(tapeIds, deleteFiles)
    // Tapes whose files couldn't be discarded are KEPT (not removed from the list);
    // surface the failure so the user is never told a removal succeeded while the
    // files (and the catalog entry) actually remain.
    if (failed.length > 0) {
      const noun = failed.length === 1 ? 'tape' : 'tapes'
      throw new Error(
        `Couldn't remove the files for ${failed.length} ${noun}: ${failed.map((f) => f.error).join('; ')}`,
      )
    }
  })

  handle('library:getSidecar', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape || !tape.sidecarFilename) {
      throw new Error(`Sidecar not available for tape ${tapeId}`)
    }
    const path = join(getLibraryDir(), tape.sidecarFilename)
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as SidecarRaw
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
    // A specific player: macOS resolves app names/bundles via `open -a`; other
    // platforms spawn the executable directly. Detached so it outlives nothing.
    const child =
      process.platform === 'darwin'
        ? spawn('open', ['-a', player, full], { detached: true, stdio: 'ignore' })
        : spawn(player, [full], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => log.error('library:playExternal failed', { player, error: describeError(err) }))
    child.unref()
  })

  handle('library:rename', async ({ tapeId, name }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)
    if (!tape.filename || !tape.sidecarFilename) {
      throw new Error('Tape has no files on disk yet')
    }
    const plan = planRename(
      {
        filename: tape.filename,
        sidecarFilename: tape.sidecarFilename,
        thumbnailFilename: tape.thumbnailFilename,
      },
      name,
    )
    if (plan.status === 'error') throw new Error(plan.message)
    if (plan.status === 'noop') return tape

    const { cleanName } = plan
    const libraryDir = getLibraryDir()
    const p = (rel: string) => join(libraryDir, rel)
    const nowUtc = nowUtcIso()

    // Resolve the plan while retaining every old public claim until the durable
    // catalog commits. A portable-equivalent spelling change keeps the existing
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
        stage: p(it.stage),
        equivalent,
        original: await claimFile(old),
      }
    }))

    const publishing = items.filter((item) => !item.equivalent)
    for (const it of publishing) {
      await assertMissing(it.fresh)
      await assertMissing(it.stage)
    }

    const byArtifact = (artifact: (typeof items)[number]['artifact']) =>
      items.find((item) => item.artifact === artifact)
    const mediaName = byArtifact('media')!.finalName
    const sidecarName = byArtifact('sidecar')!.finalName
    const thumbnailName = byArtifact('thumbnail')?.finalName ?? null
    const sidecarItem = byArtifact('sidecar')!
    const sidecar = JSON.parse(await readFile(sidecarItem.old, 'utf8')) as Record<string, unknown>
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
    // public files remain intact. Until catalog.json commits, these destination
    // claims are rollback-only and the persisted row still resolves every old file.
    const done: FileClaim[] = []
    const rollbackBeforeCatalogCommit = async (initiatingError: unknown): Promise<never> => {
      const rollbackErrors: unknown[] = []
      try {
        await unlinkClaimedFiles(done)
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError)
      }
      for (const it of publishing) {
        try {
          await unlink(it.stage)
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') rollbackErrors.push(cleanupError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [initiatingError, ...rollbackErrors],
          `Rename failed before the catalog commit and destination rollback was incomplete. ` +
            `Destination claims: ${done.map((claim) => claim.path).join(', ')}.`,
        )
      }
      throw initiatingError
    }

    try {
      for (const it of publishing) {
        if (it.artifact === 'sidecar') {
          // not recorded: this sidecar lives in the library directory beside the tape's
          // media and thumbnail — a binary-bearing directory whose contents ride along
          // into exclusion (data-backup conventions). It uses the raw writeJsonAtomic,
          // not the managed-text choke point; the tape's catalog row records instead.
          await writeJsonAtomic(it.stage, sidecar)
        } else {
          // not recorded: rename stages the tape's existing media/thumbnail bytes
          // inside the binary-bearing library. The catalog records the user-authored
          // name; copying the binary bundle does not create backup-worthy text.
          await copyFile(it.old, it.stage)
        }
      }
      for (const it of publishing) {
        done.push(await publishFileNoOverwrite(it.stage, it.fresh))
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
        await writeJsonAtomic(sidecarItem.old, sidecar)
      } catch (sidecarError) {
        postCommitErrors.push(
          new AggregateError([sidecarError], `Committed sidecar could not be updated at ${sidecarItem.old}.`),
        )
      }
    }
    const obsoleteClaims = publishing.map((item) => item.original)
    try {
      await unlinkClaimedFiles(obsoleteClaims)
    } catch (cleanupError) {
      postCommitErrors.push(cleanupError)
    }
    if (postCommitErrors.length > 0) {
      throw new AggregateError(
        postCommitErrors,
        `Rename committed and the catalog points to the new bundle, but post-commit sidecar/source cleanup was incomplete. ` +
          `Old/sidecar paths: ${[...obsoleteClaims.map((claim) => claim.path), sidecarItem.old].join(', ')}.`,
      )
    }
    log.info('renamed', { tapeId: tape.id, name: cleanName })
    return updated
  })

  handle('library:probeMetadata', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)

    // One deliberate re-probe, read-only. The probe's own idle watchdog guards a
    // stall, and it is never auto-retried — re-hammering the source is the user's
    // call. Nothing is written here: the caller reviews this and decides.
    const result = await probe(tape.sourceUrl, new AbortController().signal)
    if (result.kind === 'page') {
      throw new Error('This link now points to a list of videos, not a single video.')
    }
    return {
      title: result.title,
      uploader: result.uploader,
      description: result.description,
    }
  })

  handle('library:applyMetadata', async ({ tapeId, metadata }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)

    const dir = getLibraryDir()

    // The description lives in the sidecar (yt-dlp's info.json field), not on the
    // tape, so the accepted description is written there. Best-effort: a sidecar
    // write hiccup must not block the title/uploader update the user also accepted.
    if (tape.sidecarFilename) {
      const sidecarPath = join(dir, tape.sidecarFilename)
      try {
        const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Record<string, unknown>
        sidecar['description'] = metadata.description
        // not recorded: same as the rename path — the sidecar is library-directory
        // content, colocated with binary media, so it is excluded (data-backup
        // conventions) and takes the raw writeJsonAtomic, not the choke point.
        await writeJsonAtomic(sidecarPath, sidecar)
      } catch (err) {
        log.warn('applyMetadata: description write failed', { tapeId, error: describeError(err) })
      }
    }

    // Backfill a local poster for a downloaded tape that has none — e.g. one
    // downloaded before thumbnails were saved locally. Best-effort: the catalog
    // metadata the user reviewed must still apply even if the fetch fails. Routed
    // through the same image gate as a fresh download.
    let thumbnailFilename = tape.thumbnailFilename
    if (thumbnailFilename === null && tape.filename) {
      const stem = tape.filename.slice(0, -extname(tape.filename).length)
      try {
        const raw = await downloadThumbnail(tape.sourceUrl, dir, stem, new AbortController().signal)
        if (raw) thumbnailFilename = await saveThumbnailJpeg(raw, dir, stem)
      } catch (err) {
        log.warn('thumbnail backfill failed', { tapeId, error: describeError(err) })
      }
    }

    // Persist the accepted catalog fields. Duration and chapter count are NOT here:
    // they're fixed by the file and can't change unless it's replaced. sourceId and
    // the on-disk filenames are the tape's identity — left untouched.
    const updated: Tape = {
      ...tape,
      title: metadata.title,
      uploader: metadata.uploader,
      thumbnailFilename,
      probedAtUtc: nowUtcIso(),
    }
    session.upsertTape(updated)
    emit('tapes:updated', updated)
    log.info('applied refreshed metadata', { tapeId: tape.id })
    return updated
  })

  // Sidecar-driven import: the whole selection arrives here so this filesystem-owning
  // boundary can tell referenced bundle companions from unsupported extras. One
  // sidecar = one tape, so a duplicate is reported once, not once per selected file.
  handle('library:import', async ({ paths }) => {
    const libraryDir = getLibraryDir()
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
          reason: 'The sidecar could not be read. Check that the file is still available and try again.',
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
          reason: 'The sidecar is not valid TapeBox JSON.',
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

      const existing = session.getTapes().find((i) => i.sourceUrl === sourceUrl)
      if (existing) {
        issues.push({ path: sidecarPath, reason: 'already in library', severity: 'information' })
        continue
      }

      const srcMedia = join(dir, mediaFilename)
      try {
        await access(srcMedia, constants.R_OK)
      } catch {
        issues.push({
          path: sidecarPath,
          reason: `media file is missing beside the sidecar: ${mediaFilename}`,
          severity: 'warning',
        })
        continue
      }

      // Library names follow the media file's stem so the bundle stays internally
      // consistent (media + sidecar share a stem) regardless of the sidecar's own name.
      const mediaStem = mediaFilename.slice(0, -extname(mediaFilename).length)
      const targetMedia = join(libraryDir, mediaFilename)
      const targetSidecar = join(libraryDir, `${mediaStem}.json`)
      const copied: FileClaim[] = []
      try {
        // not recorded: import copies a media bundle (binary plus its colocated,
        // source-derived sidecar) into the binary-bearing managed library. The
        // new catalog row records the user's durable library membership instead.
        if (srcMedia !== targetMedia) {
          await assertMissing(targetMedia)
          copied.push(await writeFileAtomicNoOverwriteVia(targetMedia, (temp) => copyFile(srcMedia, temp)))
        }
        if (sidecarPath !== targetSidecar) {
          await assertMissing(targetSidecar)
          copied.push(await writeFileAtomicNoOverwriteVia(targetSidecar, (temp) => copyFile(sidecarPath, temp)))
        }
      } catch (err) {
        try {
          await unlinkClaimedFiles(copied)
          log.error('import bundle copy failed', {
            path: sidecarPath,
            error: describeError(err),
          })
          issues.push({
            path: sidecarPath,
            reason: 'The tape files could not be copied into the library. Check that the library folder is available and try again.',
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
            reason: 'The tape files could not be copied completely. Check the library folder and the log before trying again.',
            severity: 'error',
          })
        }
        continue
      }

      // Bring the local poster along if the sidecar names one and it's sitting beside
      // it. Best-effort: a missing or unreadable thumbnail just imports the tape
      // without a poster — it never rejects the import.
      let thumbnailFilename: string | null = null
      if (tbThumb) {
        const srcThumb = join(dir, tbThumb)
        const dstThumb = join(libraryDir, tbThumb)
        try {
          // not recorded: the imported thumbnail is binary image data colocated
          // with the tape's media and sidecar in the binary-bearing library.
          if (srcThumb !== dstThumb) {
            await assertMissing(dstThumb)
            await writeFileAtomicNoOverwriteVia(dstThumb, (temp) => copyFile(srcThumb, temp))
          }
          thumbnailFilename = tbThumb
        } catch (err) {
          log.error('import thumbnail copy failed', {
            path: srcThumb,
            error: describeError(err),
          })
          issues.push({
            path: srcThumb,
            reason: 'The thumbnail could not be copied into the library. The tape was imported without it.',
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

    if (imported.length > 0) emit('tapes:added', imported)
    for (const path of unsupportedSelectedPaths(paths, claimedCompanionPaths)) {
      issues.push({
        path,
        reason: 'TapeBox imports .json sidecars together with the media and image files they name.',
        severity: 'warning',
      })
    }

    log.info('library:import', { imported: imported.length, issues: issues.length })
    return { imported, issues }
  })
}

/**
 * Remove tapes from the library. With deleteFiles, each tape's media, sidecar, and
 * thumbnail are trashed (or deleted, per the Trash setting) and any leftover
 * download fragments swept; otherwise only the library entries go. An in-flight
 * download is stopped first so we never race yt-dlp's writes.
 *
 * Shared by library:remove and Export's "delete from app" (export copies the
 * files out, then calls this to take the tape out of the library).
 */
export async function removeTapes(
  tapeIds: string[],
  deleteFiles: boolean,
): Promise<{ removed: string[]; failed: { tapeId: string; error: string }[] }> {
  const settings = getSettings()
  const libraryDir = getLibraryDir()
  const removed: string[] = []
  const failed: { tapeId: string; error: string }[] = []

  for (const id of tapeIds) {
    const tape = session.getTape(id)
    if (!tape) continue

    if (queue.isActive(id)) {
      await queue.cancel(id)
    }

    if (deleteFiles) {
      try {
        if (tape.filename) {
          await discardFile(join(libraryDir, tape.filename), settings.trashOnRemove)
        }
        if (tape.sidecarFilename) {
          await discardFile(join(libraryDir, tape.sidecarFilename), settings.trashOnRemove)
        }
        if (tape.thumbnailFilename) {
          await discardFile(join(libraryDir, tape.thumbnailFilename), settings.trashOnRemove)
        }
        // Sweep any .part / .ytdl fragments yt-dlp left mid-download — incomplete
        // junk, always deleted outright (never trashed). They're named by the
        // on-disk stem, which is the tape id.
        await clearPartials(libraryDir, tape.id)
      } catch (err) {
        // The files couldn't be discarded — keep the catalog entry so the tape never
        // vanishes from the list while its files are left orphaned on disk.
        failed.push({ tapeId: id, error: errorMessage(err) })
        continue
      }
    }
    removed.push(id)
  }

  if (removed.length > 0) {
    session.removeTapes(removed)
    emit('tapes:removed', { tapeIds: removed })
  }
  return { removed, failed }
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

/**
 * True if `path`'s directory already holds a sibling with the same portable filename
 * identity: NFC-normalized and lowercased. These aliases collide on macOS/Windows
 * even when an exact `stat(path)` reports the requested spelling missing. Exact
 * physical claims may be allowed so a file is not its own collision during an
 * equivalent rename. A missing directory means no sibling.
 */
export async function caseInsensitiveSiblingExists(
  path: string,
  allowedEntries: readonly AllowedPortableDirectoryEntry[] = [],
): Promise<boolean> {
  return portableSiblingExists(path, allowedEntries)
}

async function assertMissing(path: string, allowedEntries: readonly AllowedPortableDirectoryEntry[] = []): Promise<void> {
  if (await caseInsensitiveSiblingExists(path, allowedEntries)) {
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
