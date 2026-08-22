import { access, constants, copyFile, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
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
import { publishFileNoOverwrite, writeFileAtomicNoOverwriteVia } from '@main/io/atomic-file'
import { planRename } from '@main/core/rename-plan'
import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import * as queue from '@main/queue/manager'
import { clearPartials, downloadThumbnail, probe } from '@main/services/ytdlp'
import { saveThumbnailJpeg } from '@main/services/ffmpeg'
import { nowUtcIso } from '@shared/utc'
import { frontOrders } from '@shared/order'
import { SidecarTapeBoxSchema, type Tape } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'

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
    const named = orderedIds
      .map((id) => session.getTape(id))
      .filter((t): t is Tape => !!t)
    if (named.length === 0) return

    const listKey = (t: Tape) => (t.archivedAtUtc ? `box:${t.boxId ?? 'unboxed'}` : 'inbox')
    const key = listKey(named[0])
    const namedInList = named.filter((t) => listKey(t) === key)
    const namedIds = new Set(namedInList.map((t) => t.id))

    const sequence = [
      ...namedInList.map((t) => t.id),
      ...session
        .getTapes()
        .filter((t) => listKey(t) === key && !namedIds.has(t.id))
        .sort((a, b) => a.order - b.order)
        .map((t) => t.id),
    ]

    const changed: Tape[] = []
    sequence.forEach((id, order) => {
      const tape = session.getTape(id)
      if (tape && tape.order !== order) {
        const updated = { ...tape, order }
        session.upsertTape(updated)
        changed.push(updated)
      }
    })
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

    const { cleanName, newMediaName, newSidecarName, newThumbName } = plan
    const libraryDir = getLibraryDir()
    const p = (rel: string) => join(libraryDir, rel)
    const nowUtc = nowUtcIso()

    // Resolve the planned file ops to absolute paths. Re-stem a tape's files to the
    // chosen name as one unit: media and (optional) thumbnail are plain copies, the
    // sidecar is rewritten with the new name, timestamp, and thumbnail name. Stage
    // every file under a nanoid `.tmp` sibling, then rename them all into place; the
    // originals are untouched until the very end, so a failure mid-swap is undone by
    // deleting just the new files — the session record still points at the intacts.
    const items = plan.items.map((it) => ({
      artifact: it.artifact,
      old: p(it.old),
      fresh: p(it.fresh),
      stage: p(it.stage),
      hold: p(`${it.stage}.original`),
    }))

    // The tape's own current files are the ones about to be renamed, so they must not
    // count as collisions — including when the change is only case ("Take.mp4" ->
    // "take.mp4"), which the case-insensitive scan would otherwise flag against itself.
    // caseInsensitiveSiblingExists compares against bare readdir basenames, so the
    // ignore list must be basenames too — not the absolute paths `it.old` holds.
    const ownNames = items.map((it) => basename(it.old))
    for (const it of items) {
      if (it.fresh.toLowerCase() !== it.old.toLowerCase()) await assertMissing(it.fresh, ownNames)
      await assertMissing(it.stage, ownNames)
      await assertMissing(it.hold, ownNames)
    }

    // Build every staging file, then atomically swap them into place. Both phases
    // share one cleanup: the originals stay put (their unlink is the very last step),
    // so undo is just removing any staging files plus any finals already swapped in —
    // whether the failure was a copy, the sidecar validation, or a rename.
    const done: typeof items = []
    const held: typeof items = []
    try {
      for (const it of items) {
        if (it.artifact === 'sidecar') {
          const sidecar = JSON.parse(await readFile(it.old, 'utf8')) as Record<string, unknown>
          const tb = (sidecar['tapebox'] as Record<string, unknown> | undefined) ?? {}
          tb['name'] = cleanName
          tb['renamedAtUtc'] = nowUtc
          tb['mediaFilename'] = newMediaName
          tb['thumbnailFilename'] = newThumbName
          // Validate the rewritten tapebox namespace so a rename can never downgrade
          // the sidecar into something a later import would reject.
          sidecar['tapebox'] = SidecarTapeBoxSchema.parse(tb)
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

      // A case-only rename targets the same case-insensitive directory entry as its
      // original. Hold those originals under unique sibling names first; otherwise
      // publishing the stage replaces the old file and the later old-name cleanup
      // deletes the newly published file on macOS/Windows.
      for (const it of items) {
        if (it.fresh !== it.old && it.fresh.toLowerCase() === it.old.toLowerCase()) {
          await rename(it.old, it.hold)
          held.push(it)
        }
      }

      // Final-edge exclusive publication: an external creator after preflight wins
      // with EEXIST and is never replaced. The completed stages remain rollback
      // authority until every member has committed.
      for (const it of items) {
        await publishFileNoOverwrite(it.stage, it.fresh)
        done.push(it)
      }
    } catch (err) {
      for (const it of done) await unlink(it.fresh).catch(() => {})
      for (const it of held.reverse()) await rename(it.hold, it.old).catch(() => {})
      for (const it of items) await unlink(it.stage).catch(() => {})
      throw err
    }
    const heldSet = new Set(held)
    for (const it of items) {
      if (heldSet.has(it)) await unlink(it.hold).catch(() => {})
      else if (it.fresh !== it.old) await unlink(it.old).catch(() => {})
    }

    const updated = {
      ...tape,
      filename: newMediaName,
      sidecarFilename: newSidecarName,
      thumbnailFilename: newThumbName,
      name: cleanName,
      renamedAtUtc: nowUtc,
    }
    session.upsertTape(updated)
    emit('tapes:updated', updated)
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

  // Sidecar-driven import: each path is a TapeBox .json that names its own media and
  // thumbnail (sitting beside it). We read those names from the sidecar rather than
  // guessing a media file by stem — which is what let a thumbnail get imported as the
  // video. One sidecar = one tape, so a duplicate is reported once, not per file.
  handle('library:import', async ({ sidecarPaths }) => {
    const libraryDir = getLibraryDir()
    const imported: Tape[] = []
    const rejected: { path: string; reason: string }[] = []

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

      let sidecar: Record<string, unknown>
      try {
        sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
      } catch (err) {
        rejected.push({ path: sidecarPath, reason: `sidecar parse failed: ${String(err)}` })
        continue
      }

      const classification = classifyImport(sidecar)
      if (classification.status === 'reject') {
        rejected.push({ path: sidecarPath, reason: classification.reason })
        continue
      }
      const { sourceUrl, mediaFilename, thumbnailFilename: tbThumb } = classification

      const existing = session.getTapes().find((i) => i.sourceUrl === sourceUrl)
      if (existing) {
        rejected.push({ path: sidecarPath, reason: `already in library (${existing.id})` })
        continue
      }

      const srcMedia = join(dir, mediaFilename)
      try {
        await access(srcMedia, constants.R_OK)
      } catch {
        rejected.push({ path: sidecarPath, reason: `media file is missing beside the sidecar: ${mediaFilename}` })
        continue
      }

      // Library names follow the media file's stem so the bundle stays internally
      // consistent (media + sidecar share a stem) regardless of the sidecar's own name.
      const mediaStem = mediaFilename.slice(0, -extname(mediaFilename).length)
      const targetMedia = join(libraryDir, mediaFilename)
      const targetSidecar = join(libraryDir, `${mediaStem}.json`)
      const copied: string[] = []
      try {
        // not recorded: import copies a media bundle (binary plus its colocated,
        // source-derived sidecar) into the binary-bearing managed library. The
        // new catalog row records the user's durable library membership instead.
        if (srcMedia !== targetMedia) {
          await assertMissing(targetMedia)
          await writeFileAtomicNoOverwriteVia(targetMedia, (temp) => copyFile(srcMedia, temp))
          copied.push(targetMedia)
        }
        if (sidecarPath !== targetSidecar) {
          await assertMissing(targetSidecar)
          await writeFileAtomicNoOverwriteVia(targetSidecar, (temp) => copyFile(sidecarPath, temp))
          copied.push(targetSidecar)
        }
      } catch (err) {
        await Promise.all(copied.map((path) => unlink(path).catch(() => {})))
        rejected.push({ path: sidecarPath, reason: `copy into library failed: ${String(err)}` })
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
          log.debug('import: thumbnail copy skipped', { path: srcThumb, error: describeError(err) })
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
    log.info('library:import', { imported: imported.length, rejected: rejected.length })
    return { imported, rejected }
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
 * True if `path`'s directory already holds a sibling whose name matches the target
 * basename case-insensitively — the collision macOS/Windows would silently clobber
 * even though a case-sensitive `stat(path)` reports the exact name as missing
 * (storage-path-conventions' case-insensitive-uniqueness invariant). `ignore` names
 * (compared case-insensitively) are excluded so a file is never treated as its own
 * collision when it is being re-cased in place. A missing directory = no sibling.
 */
export async function caseInsensitiveSiblingExists(path: string, ignore: string[] = []): Promise<boolean> {
  const target = basename(path).toLowerCase()
  const skip = new Set(ignore.map((n) => n.toLowerCase()))
  let entries: string[]
  try {
    entries = await readdir(dirname(path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  return entries.some((name) => name.toLowerCase() === target && !skip.has(name.toLowerCase()))
}

async function assertMissing(path: string, ignore: string[] = []): Promise<void> {
  if (await caseInsensitiveSiblingExists(path, ignore)) {
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
