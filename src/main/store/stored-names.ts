import { readFile, readdir, rename, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_COLLECTION_FOLDER, paths } from '@main/paths'
import { writeJsonAtomic, writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { FORMAT_VERSION_KEY, FORMAT_VERSIONS, parseStoreJson } from '@main/io/format-version'
import { StoreAccessError } from '@main/io/store-access'
import { describeError } from '@shared/error'

/**
 * The names stored before the library became the collection and the archive the
 * Shelf: the default folder `library/`, config.json's `libraryDir` and
 * layout.json's `archiveBoxesHeight`. Each is renamed once, at launch before the
 * settings load; a name already converted is left alone, so running it again
 * changes nothing. Files this build cannot read, or that come from a newer build,
 * are left for their own loaders to report.
 */
export async function convertStoredNames(): Promise<void> {
  await moveDefaultCollection()
  await renameStoredKey(paths.config, FORMAT_VERSIONS.config, 'libraryDir', 'collectionDir', true)
  await renameStoredKey(paths.layout, FORMAT_VERSIONS.layout, 'archiveBoxesHeight', 'shelfBoxesHeight', false)
}

async function entries(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new StoreAccessError(dir, err)
  }
}

/** Move `library/` to `collection/` when only the old folder holds anything. An
 *  empty `collection/`, such as the one ensureDirs makes, does not count. */
async function moveDefaultCollection(): Promise<void> {
  const from = join(paths.root, LEGACY_COLLECTION_FOLDER)
  const to = paths.collection
  if (await entries(from) === null) return
  const current = await entries(to)
  if (current !== null && current.length > 0) return
  try {
    if (current !== null) await rmdir(to)
    await rename(from, to)
  } catch (err) {
    throw new StoreAccessError(from, err)
  }
  log.info('default collection folder renamed', { from, to })
}

/** Rename one top-level key in a JSON store, keeping its place. When both names
 *  are present the new one is kept. */
async function renameStoredKey(path: string, version: number, from: string, to: string, managed: boolean): Promise<void> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return
  }
  const found = parseStoreJson(text, version)
  if (found.status !== 'read' || !Object.hasOwn(found.value, from)) return
  const hasNew = Object.hasOwn(found.value, to)
  const renamed = Object.fromEntries(Object.entries(found.value)
    .filter(([key]) => key !== FORMAT_VERSION_KEY && !(key === from && hasNew))
    .map(([key, value]) => [key === from ? to : key, value]))
  // layout.json only holds pane sizes, so a failed rename there loses at most
  // one saved height; config.json holds the collection's location.
  try {
    if (managed) await writeManagedJson(path, renamed, { formatVersion: version })
    else await writeJsonAtomic(path, renamed, { formatVersion: version })
  } catch (err) {
    if (managed) throw new StoreAccessError(path, err)
    log.warn('stored key not renamed', { path, from, to, error: describeError(err) })
    return
  }
  log.info('stored key renamed', { path, from, to })
}
