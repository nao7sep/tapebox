import { mkdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { areaDir, INBOX_FOLDER, SHELF_FILE, SHELF_FOLDER, shelfFile, tapeDir, tapeFile } from '@main/paths'
import { getCollectionDir } from './config'
import { writeManagedJsonBytes } from '@main/io/atomic-json'
import { StoreAccessError } from '@main/io/store-access'
import { linkOrCopyNoOverwrite } from '@main/io/atomic-file'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { frontOrders } from '@shared/order'
import { collectionSourceIndex, type SourceRef } from '@shared/source-identity'
export { durableTape } from '@shared/durable-tape'
import { TAPE_FILE, type Box, type Tape, type Session } from '@shared/domain'
import {
  encodeShelf,
  encodeTapeFile,
  readCollection,
  type CollectionLoadResult,
  type CollectionRead,
  type DamagedTape,
} from './collection-files'
import { convertLegacyCollection } from './collection-convert'
export { readCollection, type CollectionRead, type DamagedTape } from './collection-files'
export { convertLegacyCollection } from './collection-convert'

/**
 * In-memory session cache, debounced atomic persistence to the collection: each
 * tape's own tape.json in its folder under inbox/ or shelf/, and shelf.json,
 * which organizes the Shelf (collection-files.ts). Single instance per main
 * process. Live progress fields are NOT persisted — they're rebuilt by the queue
 * at runtime.
 *
 * The files hold only durable state (see {@link durableTape}): a download in
 * flight is written as the queued tape it will be again after any restart, so the
 * transient probing/ready/downloading steps never reach a file or its backup
 * history, and a file whose durable content is unchanged is not written. A save
 * writes the changed tape files first and shelf.json last. Moving tapes between
 * the Inbox and the Shelf moves their folders, in the order that leaves every
 * tape placed if it stops halfway ({@link shelveTapes}, {@link unshelveTapes}).
 *
 * Nothing writes the collection synchronously at exit. A crash, forced exit or OS
 * session end keeps the last committed files: what can be lost is the debounce
 * window of minor state (probe metadata, state transitions, box edits). Changes
 * that must survive — finished downloads, renames, reorders, Apply, moves and
 * removal — await their commit, and an ordinary quit saves with Retry, Quit
 * anyway and Cancel. A terminal writer would duplicate this publication with
 * weaker guarantees on the main thread.
 */

const SAVE_DEBOUNCE_MS = 500
/** How long a failed save waits before it tries again. */
const SAVE_RETRY_AFTER_FAILURE_MS = 30_000

let cache: Session = emptySession()
let saveTimer: NodeJS.Timeout | null = null
let loaded = false
let collectionDir: string | null = null
let persistChain: Promise<void> = Promise.resolve()
/** shelf.json's bytes last written or loaded, to skip unchanged writes. */
let lastShelfWritten: Buffer | null = null
/** Each tape file's bytes last written or loaded. A tape not here has no file yet. */
let lastTapeWritten = new Map<string, Buffer>()
/** Tapes whose folder is being discarded; no save writes into it meanwhile. */
const releasedFolders = new Set<string>()
/** The bytes a collection move's copies published, by tape id (shelf.json by its
 * name), which the moved collection starts from. */
let copiedForMove = new Map<string, Buffer>()
const tapePositions = new Map<string, number>()
const boxPositions = new Map<string, number>()
/** True from a failed save until the next successful one. */
let saveFailing = false
let saveFailureListener: (() => void) | null = null

function loadedDir(): string {
  if (collectionDir === null) throw new Error('Collection location is not loaded')
  return collectionDir
}

/** Write each changed tape file, each skipped when it matches what is already on
 * disk and reusing its exact bytes for backup. A tape's folder is made with its
 * first file. */
async function writeTapeFiles(session: Session): Promise<void> {
  const dir = loadedDir()
  for (const tape of session.tapes) {
    if (releasedFolders.has(tape.id)) continue
    const bytes = encodeTapeFile(tape)
    const previous = lastTapeWritten.get(tape.id)
    if (previous?.equals(bytes)) continue
    if (!previous) await mkdir(tapeDir(dir, tape), { recursive: true })
    await writeManagedJsonBytes(tapeFile(dir, tape, TAPE_FILE), bytes)
    lastTapeWritten.set(tape.id, bytes)
  }
}

async function writeShelf(session: Session): Promise<void> {
  const bytes = encodeShelf(session)
  if (!lastShelfWritten?.equals(bytes)) await writeManagedJsonBytes(shelfFile(loadedDir()), bytes)
  lastShelfWritten = bytes
}

/** Write the durable form of `session`: the changed tape files, then shelf.json. */
async function writeCollection(session: Session): Promise<void> {
  await writeTapeFiles(session)
  await writeShelf(session)
  saveFailing = false
}

/**
 * Called once when saves start failing (not again until one succeeds), so the
 * app edge can tell the user their collection changes are not reaching disk.
 */
export function onCollectionSaveFailure(listener: () => void): void {
  saveFailureListener = listener
}

function emptySession(): Session {
  return { tapes: [], boxes: [] }
}

/**
 * Outcome of loading the collection, so the app edge (not this I/O layer) can
 * tell the user when shelf.json or the old catalog had to be set aside or a tape
 * could not be read.
 */
export type SessionLoadResult = CollectionLoadResult & { damaged: DamagedTape[] }

/**
 * Read the collection at `dir`, converting the layout before Inbox and Shelf
 * first. A conversion stopped partway runs again from the old catalog.
 */
export async function openCollection(
  dir: string,
  options: { requireExisting?: boolean } = {},
): Promise<Extract<CollectionRead, { kind: 'current' }>> {
  const read = await readCollection(dir, options)
  if (read.kind === 'current') return read
  const converted = await convertLegacyCollection(dir, options)
  if (converted.status === 'converted') log.info('collection converted to Inbox and Shelf', { tapeCount: converted.tapeCount })
  const after = await readCollection(dir, options)
  if (after.kind !== 'current') throw new Error(`The old catalog in ${dir} is still there after conversion`)
  return converted.status === 'recovered' ? { ...after, result: { status: 'recovered', quarantinePath: converted.quarantinePath } } : after
}

/**
 * Load the app's collection into the in-memory cache. Idempotent at the app level —
 * called once during startup before any getter/mutator. A collection without a
 * readable shelf.json gets one before startup goes on.
 */
export async function loadSession(): Promise<SessionLoadResult> {
  const dir = getCollectionDir()
  // Only the built-in collection is created implicitly. An unavailable chosen
  // drive must not become an empty replacement collection.
  const directory = await stat(dir).catch((cause: unknown) => {
    throw new StoreAccessError(dir, cause)
  })
  if (!directory.isDirectory()) throw new StoreAccessError(dir, new Error('Not a directory'))
  const read = await openCollection(dir)
  bindSession(dir, read)
  if (!read.shelfWritten) await prepareCollection()

  const { result, damaged } = read
  switch (result.status) {
    case 'loaded':
      log.info('session loaded', { tapeCount: result.tapeCount })
      break
    case 'empty':
      log.info('session not found; starting empty')
      break
    case 'recovered':
      log.error('collection file corrupt; set aside', { quarantinePath: result.quarantinePath })
      break
  }
  for (const tape of damaged) log.error('tape file unreadable; left as it is', { path: tape.path, reason: tape.reason })
  return { ...result, damaged }
}

/** Bind only after the destination location has durably committed. The caller
 * runs at its collection turn and has flushed all previous writes. A read whose
 * shelf.json is missing or was set aside counts it as unwritten, so the next
 * save writes it. */
export function bindSession(dir: string, read: Pick<Extract<CollectionRead, { kind: 'current' }>, 'session' | 'shelfWritten'>): void {
  cancelScheduledSave()
  collectionDir = dir
  cache = read.session
  lastShelfWritten = read.shelfWritten ? encodeShelf(read.session) : null
  lastTapeWritten = new Map(read.session.tapes.map((tape) => [tape.id, encodeTapeFile(tape)]))
  releasedFolders.clear()
  rebuildIndexes()
  loaded = true
  saveFailing = false
}

/** The collection-relative names of the files this store writes, shelf.json first. */
export function collectionStoreFiles(): string[] {
  assertLoaded()
  return [SHELF_FILE, ...cache.tapes.map((tape) => join(tape.shelved ? SHELF_FOLDER : INBOX_FOLDER, tape.id, TAPE_FILE))]
}

/** Publish one of this store's files (see {@link collectionStoreFiles}) at
 * `destination` for a collection move, at its turn in the save order, saving the
 * cache first so no save lands between the two. */
export function copyStoreFileTo(name: string, destination: string, signal?: AbortSignal): Promise<{ crossDevice: boolean }> {
  assertLoaded()
  return enqueueCollectionWrite(async () => {
    await writeCollection(cache)
    const dir = loadedDir()
    const id = name === SHELF_FILE ? null : basename(dirname(name))
    const bytes = id === null ? lastShelfWritten : lastTapeWritten.get(id)
    if (!bytes) throw new Error(`Collection file is not written: ${name}`)
    copiedForMove.set(id ?? SHELF_FILE, bytes)
    return linkOrCopyNoOverwrite(join(dir, name), destination, signal)
  })
}

/** A move keeps the same cache at its new location. Changes saved in the old
 * folder after the copies reach the new one with the first save there. */
export function bindMovedSession(dir: string): Promise<boolean> {
  void enqueueCollectionWrite(async () => {
    collectionDir = dir
    lastShelfWritten = copiedForMove.get(SHELF_FILE) ?? null
    copiedForMove.delete(SHELF_FILE)
    lastTapeWritten = copiedForMove
    copiedForMove = new Map()
  })
  return persistNow()
}

/** Materialize even an empty collection before it is copied or moved. */
export async function prepareCollection(): Promise<void> {
  assertLoaded()
  await enqueueCollectionWrite(async () => {
    await writeCollection(cache)
  })
}

function assertLoaded(): void {
  if (!loaded) throw new Error('session.ts: loadSession() must be awaited first')
}

export function getTapes(): Tape[] {
  assertLoaded()
  return cache.tapes
}

export function sourceOwner(ref: SourceRef, exceptId?: string): string | undefined {
  assertLoaded()
  return collectionSourceIndex(cache.tapes, exceptId).find(ref)
}

export function getTape(id: string): Tape | undefined {
  assertLoaded()
  const index = tapePositions.get(id)
  return index === undefined ? undefined : cache.tapes[index]
}

export function upsertTape(tape: Tape): void {
  assertLoaded()
  const idx = tapePositions.get(tape.id) ?? -1
  if (idx >= 0) cache.tapes[idx] = tape
  else {
    tapePositions.set(tape.id, cache.tapes.length)
    cache.tapes.push(tape)
  }
  scheduleSave()
}

/** The Shelf list a shelved tape is in: a box or Loose tapes. */
function shelfListKey(tape: Tape): string {
  return tape.boxId === null ? 'loose' : `box:${tape.boxId}`
}

/** Reindex one list to `requestedIds` first, its other members after by their
 * current order. Ids not in the list are ignored. */
function reorderList(tapes: Tape[], source: string, requestedIds: readonly string[]): Tape[] {
  const members = tapes.filter((tape) => tape.shelved && shelfListKey(tape) === source)
  const memberIds = new Set(members.map((tape) => tape.id))
  const named = requestedIds.filter((id) => memberIds.has(id))
  const namedIds = new Set(named)
  const sequence = [
    ...named,
    ...members.filter((tape) => !namedIds.has(tape.id)).sort((a, b) => a.order - b.order).map((tape) => tape.id),
  ]
  const orderById = new Map(sequence.map((id, order) => [id, order]))
  return tapes.map((tape) => {
    const order = orderById.get(tape.id)
    return order === undefined || order === tape.order ? tape : { ...tape, order }
  })
}

/** Reorder the Shelf list the first submitted shelved tape is in, then await
 * its save. The Inbox has no chosen order, so its tapes are ignored. Like any
 * other collection edit it applies at once, so a later edit wins over it; a
 * failed save keeps it in the collection and is the save owner's to retry and
 * report. Returns the list's rows as they are once saved. */
export async function reorderTapesDurably(orderedIds: readonly string[]): Promise<Tape[]> {
  assertLoaded()
  const submittedIds = [...new Set(orderedIds)]
  const first = submittedIds.map(getTape).find((tape) => tape?.shelved)
  if (!first) return []
  const source = shelfListKey(first)
  cache.tapes = reorderList(cache.tapes, source, submittedIds)
  await persistNow()
  return cache.tapes.filter((tape) => tape.shelved && shelfListKey(tape) === source)
}

/** Move one tape's folder from one area to the other. A tape that never had a
 * folder gets one there with its next save. */
async function moveTapeFolder(tape: Tape, toShelf: boolean): Promise<void> {
  const dir = loadedDir()
  await mkdir(areaDir(dir, toShelf), { recursive: true })
  try {
    await rename(tapeDir(dir, tape), tapeDir(dir, { id: tape.id, shelved: toShelf }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    lastTapeWritten.delete(tape.id)
  }
}

/** Record a save failure for the save owner to retry and report. */
function saveFailed(err: unknown): void {
  log.error('session persist failed', { error: describeError(err) })
  if (!saveTimer) scheduleSave(SAVE_RETRY_AFTER_FAILURE_MS)
  if (!saveFailing) {
    saveFailing = true
    saveFailureListener?.()
  }
}

/**
 * Shelve Inbox tapes: each folder moves into shelf/, then shelf.json puts the
 * tapes on top of Loose tapes, in the given order. Stopped between the two, the
 * folder is in shelf/ without a place there, which puts it on top of Loose tapes
 * anyway. A folder that cannot be moved keeps its tape in the Inbox, and the move
 * stops there. Returns the rows as they are once moved; a failed shelf.json save
 * keeps the move and is the save owner's to retry and report.
 */
export function shelveTapes(ids: readonly string[]): Promise<Tape[]> {
  assertLoaded()
  return enqueueCollectionWrite(async () => {
    const moving = [...new Set(ids)].map(getTape).filter((tape): tape is Tape => !!tape && !tape.shelved && !releasedFolders.has(tape.id))
    const loose = cache.tapes.filter((tape) => tape.shelved && tape.boxId === null)
    const orders = frontOrders(loose.map((tape) => tape.order), moving.length)
    const moved: Tape[] = []
    let failure: unknown = null
    for (const [i, tape] of moving.entries()) {
      try {
        await moveTapeFolder(tape, true)
      } catch (error) {
        failure = error
        break
      }
      const next = { ...tape, shelved: true, boxId: null, order: orders[i]! }
      cache.tapes[tapePositions.get(tape.id)!] = next
      moved.push(next)
    }
    if (moved.length > 0) {
      try {
        await writeShelf(cache)
      } catch (error) {
        saveFailed(error)
      }
    }
    if (failure !== null) throw failure
    return moved
  })
}

/**
 * Take shelved tapes back to the Inbox: shelf.json drops them first, then each
 * folder moves into inbox/. Stopped between the two, the folder is still in
 * shelf/ without a place there, which shows it on top of Loose tapes. A folder
 * that cannot be moved keeps its tape there, and the move stops. Returns the rows
 * as they are once moved.
 */
export function unshelveTapes(ids: readonly string[]): Promise<Tape[]> {
  assertLoaded()
  return enqueueCollectionWrite(async () => {
    const moving = [...new Set(ids)].map(getTape).filter((tape): tape is Tape => !!tape && tape.shelved && !releasedFolders.has(tape.id))
    if (moving.length === 0) return []
    const movingIds = new Set(moving.map((tape) => tape.id))
    // Only shelf.json is written first: these tapes' files are still in shelf/.
    await writeShelf({ ...cache, tapes: cache.tapes.filter((tape) => !movingIds.has(tape.id)) })
    const moved: Tape[] = []
    let failure: unknown = null
    for (const tape of moving) {
      if (failure === null) {
        try {
          await moveTapeFolder(tape, false)
          const next = { ...tape, shelved: false, boxId: null, order: 0 }
          cache.tapes[tapePositions.get(tape.id)!] = next
          moved.push(next)
          continue
        } catch (error) {
          failure = error
        }
      }
      // Still on the Shelf, now on top of Loose tapes, as its next load would say.
      const loose = cache.tapes.filter((other) => other.shelved && other.boxId === null)
      cache.tapes[tapePositions.get(tape.id)!] = { ...tape, boxId: null, order: frontOrders(loose.map((other) => other.order), 1)[0]! }
    }
    if (failure !== null) {
      scheduleSave()
      throw failure
    }
    return moved
  })
}

export type RenameFields = Pick<Tape, 'filename' | 'sidecarFilename' | 'thumbnailFilename' | 'name' | 'renamedAtUtc'>

/** Commit one tape's rename fields to its tape.json before publishing them. This
 * is the transaction boundary for a filesystem rename: new paths must not become
 * authoritative until the tape's durable file names them. At its turn in the save
 * order the library is written with the fields, which then apply to the row as
 * it is by then; nothing else changes them meanwhile. Returns the current row. */
export async function renameTapeDurably(id: string, fields: RenameFields): Promise<Tape> {
  assertLoaded()
  const renamed = (tapes: Tape[]): Tape[] => tapes.map((tape) => tape.id === id ? { ...tape, ...fields } : tape)
  cancelScheduledSave()
  try {
    await enqueueCollectionWrite(async () => {
      if (!tapePositions.has(id)) throw new Error(`Tape not found during durable rename: ${id}`)
      await writeCollection({ ...cache, tapes: renamed(cache.tapes) })
      cache.tapes = renamed(cache.tapes)
    })
  } catch (error) {
    // Admission cancelled the ordinary timer; the cache still needs it.
    scheduleSave()
    throw error
  }
  return getTape(id)!
}

/**
 * Stop saving these tapes' files before their folders are discarded, once any
 * save already running has finished. {@link removeTapes} forgets them;
 * {@link keepTapeFolders} takes back one whose folder stayed.
 */
export async function releaseTapeFolders(ids: readonly string[]): Promise<void> {
  assertLoaded()
  for (const id of ids) releasedFolders.add(id)
  await enqueueCollectionWrite(async () => {})
}

export function keepTapeFolders(ids: readonly string[]): void {
  for (const id of ids) releasedFolders.delete(id)
  scheduleSave()
}

export function removeTapes(ids: string[]): void {
  assertLoaded()
  const set = new Set(ids)
  cache.tapes = cache.tapes.filter((i) => !set.has(i.id))
  for (const id of ids) {
    lastTapeWritten.delete(id)
    releasedFolders.delete(id)
  }
  rebuildIndexes()
  scheduleSave()
}

export function getBoxes(): Box[] {
  assertLoaded()
  return cache.boxes
}

export function upsertBox(box: Box): void {
  assertLoaded()
  const idx = boxPositions.get(box.id) ?? -1
  if (idx >= 0) cache.boxes[idx] = box
  else {
    boxPositions.set(box.id, cache.boxes.length)
    cache.boxes.push(box)
  }
  scheduleSave()
}

/** Reorder the boxes, the submitted ones first and any others after by their
 * current order, then await the save, as {@link reorderTapesDurably} does. */
export async function reorderBoxesDurably(orderedIds: readonly string[]): Promise<Box[]> {
  assertLoaded()
  const existingIds = new Set(cache.boxes.map((box) => box.id))
  const named = [...new Set(orderedIds)].filter((id) => existingIds.has(id))
  const namedIds = new Set(named)
  const sequence = [
    ...named,
    ...cache.boxes.filter((box) => !namedIds.has(box.id)).sort((a, b) => a.order - b.order).map((box) => box.id),
  ]
  const orderById = new Map(sequence.map((id, order) => [id, order]))
  cache.boxes = cache.boxes.map((box) => {
    const order = orderById.get(box.id)
    return order === undefined || order === box.order ? box : { ...box, order }
  })
  await persistNow()
  return cache.boxes
}

export function removeBox(id: string): void {
  assertLoaded()
  cache.boxes = cache.boxes.filter((g) => g.id !== id)
  rebuildIndexes()
  scheduleSave()
}

/** Position indexes are derived from the authoritative arrays, never a second catalog. */
function rebuildIndexes(): void {
  tapePositions.clear()
  boxPositions.clear()
  cache.tapes.forEach((tape, index) => tapePositions.set(tape.id, index))
  cache.boxes.forEach((box, index) => boxPositions.set(box.id, index))
}

function scheduleSave(delayMs = SAVE_DEBOUNCE_MS): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void persistNow() }, delayMs)
}

function cancelScheduledSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

/**
 * Flush pending writes. Called on app quit, and right after a change that must
 * reach disk before it is reported; also safe to call any time. No-op until a
 * session has actually been loaded, so a startup that aborts before load (e.g. an
 * unreadable or un-quarantinable file) can never overwrite the on-disk file with
 * the empty default.
 *
 * Resolves true once the catalog on disk matches the cache. A failed write is
 * owned here rather than by the caller: the change stays in the cache (it already
 * happened — a finished download's files are on disk), the save is retried after
 * {@link SAVE_RETRY_AFTER_FAILURE_MS} and at quit, the failure listener tells the
 * user, and this resolves false. A quit tells the user itself, in its own
 * dialog rather than a notice while exiting, so it passes `quitting`.
 */
export async function persistNow(options: { quitting?: boolean } = {}): Promise<boolean> {
  if (!loaded) return true
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    await enqueueCollectionWrite(async () => {
      // Snapshot at execution, not enqueue time: a durable rename ahead of this
      // write may either commit or roll back while this call is waiting its turn.
      // The tape files and shelf.json are the app's most important durable
      // managed text, so every changed file records through the choke point.
      await writeCollection(cache)
    })
    return true
  } catch (err) {
    log.error('session persist failed', { error: describeError(err) })
    if (!saveTimer) scheduleSave(SAVE_RETRY_AFTER_FAILURE_MS)
    if (!saveFailing) {
      saveFailing = true
      if (!options.quitting) saveFailureListener?.()
    }
    return false
  }
}

function enqueueCollectionWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = persistChain.then(write)
  persistChain = run.then(() => {}, () => {})
  return run
}
