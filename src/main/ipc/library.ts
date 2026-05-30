import { access, constants, copyFile, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
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
import { nowUtcIso } from '@shared/utc'
import type { Item } from '@shared/domain'
import type { SidecarRaw } from '@shared/ipc-contract'

export function registerLibraryHandlers(): void {
  handle('library:list', async () => session.getItems())

  handle('library:archive', async ({ itemIds }) => {
    const at = nowUtcIso()
    for (const id of itemIds) {
      const item = session.getItem(id)
      if (!item || item.archivedAtUtc) continue
      const updated = { ...item, archivedAtUtc: at }
      session.upsertItem(updated)
      emit('items:updated', updated)
    }
  })

  handle('library:unarchive', async ({ itemIds }) => {
    for (const id of itemIds) {
      const item = session.getItem(id)
      if (!item || !item.archivedAtUtc) continue
      const updated = { ...item, archivedAtUtc: null }
      session.upsertItem(updated)
      emit('items:updated', updated)
    }
  })

  handle('library:remove', async ({ itemIds, deleteFiles }) => {
    const settings = getSettings()
    for (const id of itemIds) {
      const item = session.getItem(id)
      if (!item) continue

      // Stop any in-flight yt-dlp process before touching disk. cancel()
      // resolves only after the process has exited and the Job's finally
      // blocks have run; otherwise we'd race with yt-dlp's own writes.
      if (queue.isActive(id)) {
        await queue.cancel(id)
      }

      if (deleteFiles) {
        if (item.filename) {
          await discardFile(join(settings.libraryDir, item.filename), settings.trashOnRemove)
        }
        if (item.sidecarFilename) {
          await discardFile(join(settings.libraryDir, item.sidecarFilename), settings.trashOnRemove)
        }
        // Sweep any .part / .ytdl files yt-dlp left when cancelled mid-download.
        // These are incomplete junk, always deleted outright (never trashed).
        if (item.sourceId) {
          await sweepPartials(settings.libraryDir, item.sourceId)
        }
      }
    }
    session.removeItems(itemIds)
    emit('items:removed', { itemIds })
  })

  handle('library:getSidecar', async ({ itemId }) => {
    const item = session.getItem(itemId)
    if (!item || !item.sidecarFilename) {
      throw new Error(`Sidecar not available for item ${itemId}`)
    }
    const path = join(getSettings().libraryDir, item.sidecarFilename)
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as SidecarRaw
  })

  handle('library:renameToSlug', async ({ itemId, slug }) => {
    const item = session.getItem(itemId)
    if (!item) throw new Error(`Item not found: ${itemId}`)
    if (!item.filename || !item.sidecarFilename) {
      throw new Error('Item has no files on disk yet')
    }
    const cleanSlug = slugifyAscii(slug)
    if (!isValidSlug(cleanSlug)) {
      throw new Error(`Invalid slug: "${cleanSlug}"`)
    }

    const settings = getSettings()
    const mediaExt = extname(item.filename)
    const newMediaName = `${cleanSlug}${mediaExt}`
    const newSidecarName = `${cleanSlug}.json`

    if (newMediaName === item.filename && newSidecarName === item.sidecarFilename) {
      return item
    }

    const oldMediaPath = join(settings.libraryDir, item.filename)
    const oldSidecarPath = join(settings.libraryDir, item.sidecarFilename)
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
      ...item,
      filename: newMediaName,
      sidecarFilename: newSidecarName,
      slug: cleanSlug,
      renamedAtUtc: nowUtc,
    }
    session.upsertItem(updated)
    emit('items:updated', updated)
    log.info(`renamed: ${item.id} -> ${cleanSlug}`)
    return updated
  })

  handle('library:import', async ({ mediaPaths }) => {
    const settings = getSettings()
    const imported: Item[] = []
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
      const existing = session.getItems().find((i) => i.sourceUrl === sourceUrl)
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

      const item: Item = {
        id: nanoid(10),
        sourceUrl,
        state: 'downloaded',
        addedAtUtc: (typeof tb['addedAtUtc'] === 'string' ? tb['addedAtUtc'] : null) ?? nowUtcIso(),
        sourceId: typeof sidecar['id'] === 'string' ? sidecar['id'] : null,
        title: typeof sidecar['title'] === 'string' ? sidecar['title'] : null,
        originalTitle: typeof tb['originalTitle'] === 'string' ? tb['originalTitle'] : null,
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
        pausedAtUtc: null,
        failedAtUtc: null,
        lastError: null,
      }
      session.upsertItem(item)
      imported.push(item)
    }

    if (imported.length > 0) emit('items:added', imported)
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

/**
 * Delete any .part / .ytdl / .frag* files left in the library dir whose
 * basename starts with the given sourceId. yt-dlp produces these while
 * downloading; if cancelled mid-flight they need cleanup.
 */
async function sweepPartials(libraryDir: string, sourceId: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(libraryDir)
  } catch {
    return
  }
  const targets = entries.filter((name) => {
    if (!name.startsWith(sourceId)) return false
    return name.endsWith('.part') || name.endsWith('.ytdl') || /\.frag(\d+)?$/.test(name)
  })
  for (const name of targets) {
    await unlink(join(libraryDir, name)).catch(() => {})
  }
}
