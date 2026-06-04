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
import { writeJsonAtomic } from '@main/io/atomic-json'
import { isValidSlug, slugifyAscii } from '@main/core/slug'
import * as queue from '@main/queue/manager'
import { clearPartials, probe } from '@main/services/ytdlp'
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
        // Sweep any .part / .ytdl fragments yt-dlp left mid-download — incomplete
        // junk, always deleted outright (never trashed).
        if (tape.sourceId) {
          await clearPartials(settings.libraryDir, tape.sourceId)
        }
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
    child.on('error', (err) => log.error('library:playExternal failed', { player, error: String(err) }))
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
    const mediaExt = extname(tape.filename)
    const newMediaName = `${cleanSlug}${mediaExt}`
    const newSidecarName = `${cleanSlug}.json`

    if (newMediaName === tape.filename && newSidecarName === tape.sidecarFilename) {
      return tape
    }

    const oldMediaPath = join(settings.libraryDir, tape.filename)
    const oldSidecarPath = join(settings.libraryDir, tape.sidecarFilename)
    const newMediaPath = join(settings.libraryDir, newMediaName)
    const newSidecarPath = join(settings.libraryDir, newSidecarName)

    // Stage-then-swap: write copies under .staging suffixes, then atomically
    // rename them into place, then unlink the originals. The originals stay
    // intact until both staging files exist, so any failure mid-flight leaves
    // disk state recoverable without a rollback dance.
    const stageMedia = `${newMediaPath}.staging`
    const stageSidecar = `${newSidecarPath}.staging`

    // Collision check: target files (and our staging files) must not exist.
    if (newMediaPath !== oldMediaPath)     await assertMissing(newMediaPath)
    if (newSidecarPath !== oldSidecarPath) await assertMissing(newSidecarPath)
    await assertMissing(stageMedia)
    await assertMissing(stageSidecar)

    const nowUtc = nowUtcIso()

    try {
      await copyFile(oldMediaPath, stageMedia)

      const sidecarText = await readFile(oldSidecarPath, 'utf8')
      const sidecar = JSON.parse(sidecarText) as Record<string, unknown>
      const tb = (sidecar['tapebox'] as Record<string, unknown> | undefined) ?? {}
      tb['slug'] = cleanSlug
      tb['renamedAtUtc'] = nowUtc
      sidecar['tapebox'] = tb
      await writeJsonAtomic(stageSidecar, sidecar)

      // Atomic swap: rename staging -> final. Same filesystem so this is
      // a single inode operation each. Windows refuses the rename if
      // newMediaPath happens to be an open file handle; that condition
      // bubbles up as a clear error instead of leaving partial state.
      await rename(stageMedia, newMediaPath)
      await rename(stageSidecar, newSidecarPath)

      await unlink(oldMediaPath).catch(() => {})
      await unlink(oldSidecarPath).catch(() => {})
    } catch (err) {
      // Clean up staging if it landed.
      await unlink(stageMedia).catch(() => {})
      await unlink(stageSidecar).catch(() => {})
      // If the FIRST rename succeeded but the second failed, the new media
      // file exists at the target but the sidecar does not. Roll the media
      // rename back so the session record stays consistent with disk.
      if (await fileExists(newMediaPath) && !(await fileExists(newSidecarPath))) {
        await rename(newMediaPath, oldMediaPath).catch((rollbackErr) => {
          log.error('renameToSlug: rollback failed', {
            from: newMediaPath,
            to: oldMediaPath,
            error: String(rollbackErr),
          })
        })
      }
      throw err
    }

    const updated = {
      ...tape,
      filename: newMediaName,
      sidecarFilename: newSidecarName,
      slug: cleanSlug,
      renamedAtUtc: nowUtc,
    }
    session.upsertTape(updated)
    emit('tapes:updated', updated)
    log.info(`renamed: ${tape.id} -> ${cleanSlug}`)
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
      thumbnailUrl: result.thumbnail,
    }
  })

  handle('library:applyMetadata', async ({ tapeId, metadata }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)

    // Persist exactly the catalog metadata the user accepted from the preview.
    // sourceId and the on-disk filenames are the tape's identity — leave them
    // untouched so a downloaded tape keeps pointing at its existing files.
    const updated: Tape = {
      ...tape,
      title: metadata.title,
      uploader: metadata.uploader,
      durationSeconds: metadata.durationSeconds,
      chapterCount: metadata.chapterCount ?? tape.chapterCount,
      thumbnailUrl: metadata.thumbnailUrl,
      probedAtUtc: nowUtcIso(),
    }
    session.upsertTape(updated)
    emit('tapes:updated', updated)
    log.info(`applied refreshed metadata: ${tape.id}`)
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

      const tape: Tape = {
        id: nanoid(10),
        sourceUrl,
        state: 'downloaded',
        addedAtUtc: (typeof tb['addedAtUtc'] === 'string' ? tb['addedAtUtc'] : null) ?? nowUtcIso(),
        sourceId: typeof sidecar['id'] === 'string' ? sidecar['id'] : null,
        title: typeof sidecar['title'] === 'string' ? sidecar['title'] : null,
        uploader: typeof sidecar['uploader'] === 'string' ? sidecar['uploader'] : null,
        durationSeconds: typeof sidecar['duration'] === 'number' ? sidecar['duration'] : null,
        chapterCount: Array.isArray(sidecar['chapters']) ? (sidecar['chapters'] as unknown[]).length : 0,
        thumbnailUrl: typeof sidecar['thumbnail'] === 'string' ? sidecar['thumbnail'] : null,
        probedAtUtc: nowUtcIso(),
        filename: mediaBasename,
        sidecarFilename: `${stem}.json`,
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
    log.error('library:remove: trashItem failed', { path, error: String(err) })
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
