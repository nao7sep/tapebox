import { access, constants, copyFile, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { isValidSlug, slugifyAscii } from '@main/core/slug'
import * as queue from '@main/queue/manager'
import { clearPartials, downloadThumbnail, probe } from '@main/services/ytdlp'
import { saveThumbnailJpeg } from '@main/services/ffmpeg'
import { nowUtcIso } from '@shared/utc'
import type { Tape } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'

export function registerLibraryHandlers(): void {
  handle('library:list', async () => session.getTapes())

  handle('library:archive', async ({ tapeIds }) => {
    const at = nowUtcIso()
    for (const id of tapeIds) {
      const tape = session.getTape(id)
      if (!tape || tape.archivedAtUtc) continue
      const updated = { ...tape, archivedAtUtc: at }
      session.upsertTape(updated)
      emit('tapes:updated', updated)
    }
  })

  handle('library:unarchive', async ({ tapeIds }) => {
    for (const id of tapeIds) {
      const tape = session.getTape(id)
      if (!tape || !tape.archivedAtUtc) continue
      // Leaving the archive drops all archive organization — re-archiving later
      // starts fresh in Loose.
      const updated = { ...tape, archivedAtUtc: null, boxId: null, boxOrder: 0 }
      session.upsertTape(updated)
      emit('tapes:updated', updated)
    }
  })

  handle('library:remove', async ({ tapeIds, deleteFiles }) => {
    const settings = getSettings()
    for (const id of tapeIds) {
      const tape = session.getTape(id)
      if (!tape) continue

      // Stop any in-flight yt-dlp process before touching disk. cancel()
      // resolves only after the process has exited and the Job's finally
      // blocks have run; otherwise we'd race with yt-dlp's own writes.
      if (queue.isActive(id)) {
        await queue.cancel(id)
      }

      if (deleteFiles) {
        if (tape.filename) {
          await discardFile(join(settings.libraryDir, tape.filename), settings.trashOnRemove)
        }
        if (tape.sidecarFilename) {
          await discardFile(join(settings.libraryDir, tape.sidecarFilename), settings.trashOnRemove)
        }
        if (tape.thumbnailFilename) {
          await discardFile(join(settings.libraryDir, tape.thumbnailFilename), settings.trashOnRemove)
        }
        // Sweep any .part / .ytdl fragments yt-dlp left mid-download — incomplete
        // junk, always deleted outright (never trashed). They're named by the
        // on-disk stem, which is the tape id.
        await clearPartials(settings.libraryDir, tape.id)
      }
    }
    session.removeTapes(tapeIds)
    emit('tapes:removed', { tapeIds })
  })

  handle('library:getSidecar', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape || !tape.sidecarFilename) {
      throw new Error(`Sidecar not available for tape ${tapeId}`)
    }
    const path = join(getSettings().libraryDir, tape.sidecarFilename)
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as SidecarRaw
  })

  handle('library:reveal', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape?.filename) throw new Error('No file to reveal for this tape')
    shell.showItemInFolder(join(getSettings().libraryDir, tape.filename))
  })

  handle('library:playExternal', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape?.filename) throw new Error('No file to play for this tape')
    const full = join(getSettings().libraryDir, tape.filename)
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

  handle('library:renameToSlug', async ({ tapeId, slug }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)
    if (!tape.filename || !tape.sidecarFilename) {
      throw new Error('Tape has no files on disk yet')
    }
    const cleanSlug = slugifyAscii(slug)
    if (!isValidSlug(cleanSlug)) {
      throw new Error(`Invalid slug: "${cleanSlug}"`)
    }

    const settings = getSettings()
    const p = (name: string) => join(settings.libraryDir, name)

    const newMediaName = `${cleanSlug}${extname(tape.filename)}`
    const newSidecarName = `${cleanSlug}.json`
    const newThumbName = tape.thumbnailFilename ? `${cleanSlug}${extname(tape.thumbnailFilename)}` : null

    if (
      newMediaName === tape.filename &&
      newSidecarName === tape.sidecarFilename &&
      newThumbName === tape.thumbnailFilename
    ) {
      return tape
    }

    const nowUtc = nowUtcIso()
    const sidecarFresh = p(newSidecarName)

    // Re-stem a tape's files to the slug as one unit: the media and (optional)
    // thumbnail are plain copies, the sidecar is rewritten with the new slug,
    // timestamp, and thumbnail name. Stage every file under a .staging suffix,
    // then rename them all into place; the originals are untouched until the very
    // end, so a failure mid-swap is undone by deleting just the new files we
    // created — the session record still points at the intact originals.
    const items = [
      { old: p(tape.filename), fresh: p(newMediaName) },
      { old: p(tape.sidecarFilename), fresh: sidecarFresh },
      ...(tape.thumbnailFilename && newThumbName
        ? [{ old: p(tape.thumbnailFilename), fresh: p(newThumbName) }]
        : []),
    ].map((it) => ({ ...it, stage: `${it.fresh}.staging` }))

    for (const it of items) {
      if (it.fresh !== it.old) await assertMissing(it.fresh)
      await assertMissing(it.stage)
    }

    for (const it of items) {
      if (it.fresh === sidecarFresh) {
        const sidecar = JSON.parse(await readFile(it.old, 'utf8')) as Record<string, unknown>
        const tb = (sidecar['tapebox'] as Record<string, unknown> | undefined) ?? {}
        tb['slug'] = cleanSlug
        tb['renamedAtUtc'] = nowUtc
        tb['thumbnailFilename'] = newThumbName
        sidecar['tapebox'] = tb
        await writeJsonAtomic(it.stage, sidecar)
      } else {
        await copyFile(it.old, it.stage)
      }
    }

    // Atomic swap: rename staging -> final, one inode op each on the same
    // filesystem. Windows refuses the rename if a target is an open file handle;
    // that surfaces as a clear error rather than partial state.
    const done: typeof items = []
    try {
      for (const it of items) {
        await rename(it.stage, it.fresh)
        done.push(it)
      }
    } catch (err) {
      // The originals are still in place (their unlink is the last step), so undo
      // is just removing the new files we created and any leftover staging.
      for (const it of done) if (it.fresh !== it.old) await unlink(it.fresh).catch(() => {})
      for (const it of items) await unlink(it.stage).catch(() => {})
      throw err
    }
    for (const it of items) if (it.fresh !== it.old) await unlink(it.old).catch(() => {})

    const updated = {
      ...tape,
      filename: newMediaName,
      sidecarFilename: newSidecarName,
      thumbnailFilename: newThumbName,
      slug: cleanSlug,
      renamedAtUtc: nowUtc,
    }
    session.upsertTape(updated)
    emit('tapes:updated', updated)
    log.info('renamed', { tapeId: tape.id, slug: cleanSlug })
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
      durationSeconds: result.duration,
      chapterCount: result.chapters?.length ?? null,
    }
  })

  handle('library:applyMetadata', async ({ tapeId, metadata }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)

    // Backfill a local poster for a downloaded tape that has none — e.g. one
    // downloaded before thumbnails were saved locally. Best-effort: the catalog
    // metadata the user reviewed must still apply even if the fetch fails. Routed
    // through the same image gate as a fresh download.
    let thumbnailFilename = tape.thumbnailFilename
    if (thumbnailFilename === null && tape.filename) {
      const dir = getSettings().libraryDir
      const stem = tape.filename.slice(0, -extname(tape.filename).length)
      try {
        const raw = await downloadThumbnail(tape.sourceUrl, dir, stem, new AbortController().signal)
        if (raw) thumbnailFilename = await saveThumbnailJpeg(raw, dir, stem)
      } catch (err) {
        log.warn('thumbnail backfill failed', { tapeId, error: describeError(err) })
      }
    }

    // Persist exactly the catalog metadata the user accepted from the preview.
    // sourceId and the on-disk filenames are the tape's identity — leave them
    // untouched so a downloaded tape keeps pointing at its existing files.
    const updated: Tape = {
      ...tape,
      title: metadata.title,
      uploader: metadata.uploader,
      durationSeconds: metadata.durationSeconds,
      chapterCount: metadata.chapterCount ?? tape.chapterCount,
      thumbnailFilename,
      probedAtUtc: nowUtcIso(),
    }
    session.upsertTape(updated)
    emit('tapes:updated', updated)
    log.info('applied refreshed metadata', { tapeId: tape.id })
    return updated
  })

  handle('library:import', async ({ mediaPaths }) => {
    const settings = getSettings()
    const imported: Tape[] = []
    const rejected: { path: string; reason: string }[] = []

    for (const mediaPath of mediaPaths) {
      const dir = dirname(mediaPath)
      const mediaBasename = basename(mediaPath)
      const stem = mediaBasename.slice(0, -extname(mediaBasename).length)
      const sidecarPath = join(dir, `${stem}.json`)

      try {
        await access(sidecarPath, constants.R_OK)
      } catch {
        rejected.push({ path: mediaPath, reason: 'no matching sidecar (same name, .json)' })
        continue
      }

      let sidecar: Record<string, unknown>
      try {
        const text = await readFile(sidecarPath, 'utf8')
        sidecar = JSON.parse(text)
      } catch (err) {
        rejected.push({ path: mediaPath, reason: `sidecar parse failed: ${String(err)}` })
        continue
      }

      const tb = sidecar['tapebox'] as Record<string, unknown> | undefined
      if (!tb || typeof tb['sourceUrl'] !== 'string') {
        rejected.push({ path: mediaPath, reason: 'sidecar missing tapebox.sourceUrl' })
        continue
      }

      const sourceUrl = tb['sourceUrl']
      const existing = session.getTapes().find((i) => i.sourceUrl === sourceUrl)
      if (existing) {
        rejected.push({ path: mediaPath, reason: `already in library (${existing.id})` })
        continue
      }

      const targetMediaPath = join(settings.libraryDir, mediaBasename)
      const targetSidecarPath = join(settings.libraryDir, `${stem}.json`)
      try {
        if (mediaPath !== targetMediaPath) {
          await assertMissing(targetMediaPath)
          await copyFile(mediaPath, targetMediaPath)
        }
        if (sidecarPath !== targetSidecarPath) {
          await assertMissing(targetSidecarPath)
          await copyFile(sidecarPath, targetSidecarPath)
        }
      } catch (err) {
        rejected.push({ path: mediaPath, reason: `copy into library failed: ${String(err)}` })
        continue
      }

      // Bring the local poster along if the sidecar names one and it's sitting
      // beside the media. Best-effort: a missing or unreadable thumbnail just
      // imports the tape without a poster — it never rejects the import.
      let thumbnailFilename: string | null = null
      const tbThumb = typeof tb['thumbnailFilename'] === 'string' ? tb['thumbnailFilename'] : null
      if (tbThumb) {
        const srcThumb = join(dir, tbThumb)
        const dstThumb = join(settings.libraryDir, tbThumb)
        try {
          if (srcThumb !== dstThumb) {
            await assertMissing(dstThumb)
            await copyFile(srcThumb, dstThumb)
          }
          thumbnailFilename = tbThumb
        } catch (err) {
          log.debug('import: thumbnail copy skipped', { path: srcThumb, error: describeError(err) })
        }
      }

      const tape: Tape = {
        id: nanoid(10),
        sourceUrl,
        state: 'downloaded',
        addedAtUtc: (typeof tb['addedAtUtc'] === 'string' ? tb['addedAtUtc'] : null) ?? nowUtcIso(),
        sourceId: typeof sidecar['id'] === 'string' ? sidecar['id'] : null,
        extractor: typeof sidecar['extractor'] === 'string' ? sidecar['extractor'] : null,
        title: typeof sidecar['title'] === 'string' ? sidecar['title'] : null,
        uploader: typeof sidecar['uploader'] === 'string' ? sidecar['uploader'] : null,
        durationSeconds: typeof sidecar['duration'] === 'number' ? sidecar['duration'] : null,
        chapterCount: Array.isArray(sidecar['chapters']) ? (sidecar['chapters'] as unknown[]).length : 0,
        probedAtUtc: nowUtcIso(),
        filename: mediaBasename,
        sidecarFilename: `${stem}.json`,
        thumbnailFilename,
        downloadStartedAtUtc: null,
        downloadedAtUtc: typeof tb['downloadedAtUtc'] === 'string' ? tb['downloadedAtUtc'] : nowUtcIso(),
        slug: typeof tb['slug'] === 'string' ? tb['slug'] : null,
        renamedAtUtc: typeof tb['renamedAtUtc'] === 'string' ? tb['renamedAtUtc'] : null,
        archivedAtUtc: null,
        boxId: null,
        boxOrder: 0,
        pausedAtUtc: null,
        failedAtUtc: null,
        lastError: null,
      }
      session.upsertTape(tape)
      imported.push(tape)
    }

    if (imported.length > 0) emit('tapes:added', imported)
    log.info('library:import', { imported: imported.length, rejected: rejected.length })
    return { imported, rejected }
  })
}

/**
 * Discard one file on removal: move it to the OS Trash (recoverable) when
 * trashing is on, else delete it permanently. A missing file is a no-op either
 * way. trashItem rejects on real failure — surfaced via log, not swallowed, so
 * a claimed "moved to Trash" is actually true.
 */
async function discardFile(path: string, toTrash: boolean): Promise<void> {
  if (!toTrash) {
    await unlink(path).catch(() => {})
    return
  }
  if (!(await fileExists(path))) return
  try {
    await shell.trashItem(path)
  } catch (err) {
    log.error('library:remove: trashItem failed', { path, error: describeError(err) })
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await stat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  throw new Error(`Target already exists: ${path}`)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
