import { access, constants, copyFile, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { isValidSlug, normalizeSlug } from '@main/core/slug'
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
      if (deleteFiles) {
        if (item.filename) {
          await unlink(join(settings.libraryDir, item.filename)).catch(() => {})
        }
        if (item.sidecarFilename) {
          await unlink(join(settings.libraryDir, item.sidecarFilename)).catch(() => {})
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
    const cleanSlug = normalizeSlug(slug)
    if (!isValidSlug(cleanSlug)) {
      throw new Error(`Invalid slug: "${cleanSlug}"`)
    }

    const settings = getSettings()
    const mediaExt = extname(item.filename)
    const newMediaName = `${cleanSlug}${mediaExt}`
    const newSidecarName = `${cleanSlug}.json`

    // No rename needed.
    if (newMediaName === item.filename && newSidecarName === item.sidecarFilename) {
      return item
    }

    const oldMediaPath = join(settings.libraryDir, item.filename)
    const oldSidecarPath = join(settings.libraryDir, item.sidecarFilename)
    const newMediaPath = join(settings.libraryDir, newMediaName)
    const newSidecarPath = join(settings.libraryDir, newSidecarName)

    // Collision check: fail loudly if either target exists.
    if (newMediaPath !== oldMediaPath)     await assertMissing(newMediaPath)
    if (newSidecarPath !== oldSidecarPath) await assertMissing(newSidecarPath)

    await rename(oldMediaPath, newMediaPath)
    try {
      await rename(oldSidecarPath, newSidecarPath)
    } catch (err) {
      // Roll the media rename back so on-disk state stays consistent.
      await rename(newMediaPath, oldMediaPath).catch(() => {})
      throw err
    }

    const nowUtc = nowUtcIso()
    const sidecarText = await readFile(newSidecarPath, 'utf8')
    const sidecar = JSON.parse(sidecarText) as Record<string, unknown>
    const tb = (sidecar.tapebox as Record<string, unknown> | undefined) ?? {}
    tb.slug = cleanSlug
    tb.renamedAtUtc = nowUtc
    sidecar.tapebox = tb
    await writeJsonAtomic(newSidecarPath, sidecar)

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

  handle('library:refreshMetadata', async ({ itemId }) => {
    const item = session.getItem(itemId)
    if (!item) throw new Error(`Item not found: ${itemId}`)
    log.warn('library:refreshMetadata not yet implemented', { itemId })
    return item
  })

  handle('library:import', async ({ mediaPaths }) => {
    const settings = getSettings()
    const imported: Item[] = []
    const rejected: { path: string; reason: string }[] = []

    for (const mediaPath of mediaPaths) {
      // Sidecar lookup: same directory, same stem, .json extension.
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

      const tb = sidecar.tapebox as Record<string, unknown> | undefined
      if (!tb || typeof tb.sourceUrl !== 'string') {
        rejected.push({ path: mediaPath, reason: 'sidecar missing tapebox.sourceUrl' })
        continue
      }

      const sourceUrl = tb.sourceUrl
      const existing = session.getItems().find((i) => i.sourceUrl === sourceUrl)
      if (existing) {
        rejected.push({ path: mediaPath, reason: `already in library (${existing.id})` })
        continue
      }

      // Copy both files into libraryDir if they aren't already there.
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
        addedAtUtc: (typeof tb.addedAtUtc === 'string' ? tb.addedAtUtc : null) ?? nowUtcIso(),
        sourceId: typeof sidecar.id === 'string' ? sidecar.id : null,
        title: typeof sidecar.title === 'string' ? sidecar.title : null,
        originalTitle: typeof tb.originalTitle === 'string' ? tb.originalTitle : null,
        uploader: typeof sidecar.uploader === 'string' ? sidecar.uploader : null,
        durationSeconds: typeof sidecar.duration === 'number' ? sidecar.duration : null,
        chapterCount: Array.isArray(sidecar.chapters) ? (sidecar.chapters as unknown[]).length : 0,
        thumbnailUrl: typeof sidecar.thumbnail === 'string' ? sidecar.thumbnail : null,
        probedAtUtc: nowUtcIso(),
        filename: mediaBasename,
        sidecarFilename: `${stem}.json`,
        downloadedAtUtc: typeof tb.downloadedAtUtc === 'string' ? tb.downloadedAtUtc : nowUtcIso(),
        slug: typeof tb.slug === 'string' ? tb.slug : null,
        renamedAtUtc: typeof tb.renamedAtUtc === 'string' ? tb.renamedAtUtc : null,
        archivedAtUtc: null,
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

async function assertMissing(path: string): Promise<void> {
  try {
    await stat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  throw new Error(`Target already exists: ${path}`)
}
