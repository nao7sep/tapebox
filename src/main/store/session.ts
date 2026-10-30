import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { collectionCatalog } from '@main/paths'
import { getLibraryDir } from './config'
import { quarantineFile, serializeStoreJson, writeManagedJsonBytes } from '@main/io/atomic-json'
import { StoreAccessError } from '@main/io/store-access'
import { linkOrCopyNoOverwrite } from '@main/io/atomic-file'
import { FORMAT_VERSIONS, NewerFormatError, parseStoreJson } from '@main/io/format-version'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { librarySourceIndex, type SourceRef } from '@shared/source-identity'
import { durableTape } from '@shared/durable-tape'
export { durableTape } from '@shared/durable-tape'
import { SessionSchema, type Box, type Tape, type Session } from '@shared/domain'

/**
 * In-memory session cache, debounced atomic persistence to the library catalog.
 * Single instance per main process. Live progress fields are NOT persisted —
 * they're rebuilt by the queue at runtime.
 *
 * catalog.json holds only durable state (see {@link durableTape}): a download in
 * flight is written as the queued tape it will be again after any restart, so the
 * transient probing/ready/downloading steps never reach the file or its backup
 * history, and a write whose durable content is unchanged is skipped.
 *
 * Nothing writes the catalog synchronously at exit. A crash, forced exit or OS
 * session end keeps the last committed catalog: what can be lost is the debounce
 * window of minor state (probe metadata, state transitions, box edits). Changes
 * that must survive — finished downloads, renames, reorders, Apply and removal —
 * await their commit, and an ordinary quit saves with Retry, Quit anyway and
 * Cancel. A terminal writer would duplicate this publication with weaker
 * guarantees on the main thread.
 */

const SAVE_DEBOUNCE_MS = 500
/** How long a failed catalog save waits before it tries again. */
const SAVE_RETRY_AFTER_FAILURE_MS = 30_000

let cache: Session = emptySession()
let saveTimer: NodeJS.Timeout | null = null
let loaded = false
let catalogPath: string | null = null
let persistChain: Promise<void> = Promise.resolve()
/** Serialized durable content last written or loaded, to skip unchanged writes. */
let lastWritten: Buffer | null = null
/** The bytes a library move's copy published, which the moved catalog starts from. */
let copiedForMove: Buffer | null = null
const tapePositions = new Map<string, number>()
const boxPositions = new Map<string, number>()
/** True from a failed catalog save until the next successful one. */
let saveFailing = false
let saveFailureListener: (() => void) | null = null

/** How catalog.json is written. */
const CATALOG_JSON = { formatVersion: FORMAT_VERSIONS.catalog, schema: SessionSchema }

/** The exact bytes of `session`'s durable form, validated once per save. */
function encodeCatalog(session: Session): Buffer {
  return Buffer.from(serializeStoreJson({ tapes: session.tapes.map(durableTape), boxes: session.boxes }, CATALOG_JSON), 'utf8')
}

/** Write the durable form of `session` unless it matches what is already on
 * disk, reusing its exact bytes for backup. */
async function writeCatalog(session: Session): Promise<void> {
  if (catalogPath === null) throw new Error('Catalog location is not loaded')
  const bytes = encodeCatalog(session)
  if (!lastWritten?.equals(bytes)) await writeManagedJsonBytes(catalogPath, bytes)
  lastWritten = bytes
  saveFailing = false
}

/**
 * Called once when catalog saves start failing (not again until one succeeds), so
 * the app edge can tell the user their library changes are not reaching disk.
 */
export function onCatalogSaveFailure(listener: () => void): void {
  saveFailureListener = listener
}

function emptySession(): Session {
  return { tapes: [], boxes: [] }
}

/**
 * Outcome of loading the session file, so the app edge (not this I/O layer) can
 * tell the user when their library file had to be set aside.
 */
export type SessionLoadResult =
  | { status: 'loaded'; tapeCount: number }
  | { status: 'empty' }
  | { status: 'recovered'; quarantinePath: string }

/**
 * Read and validate the session file at `sessionPath`. Path-taking and
 * side-effect-localized (no module state, no app logging) so it is unit-testable
 * against a real temp dir, the way the rest of the I/O layer is.
 *
 * A corrupt or schema-invalid file is **never discarded**: it is renamed to a
 * timestamped `catalog-*.invalid` sibling so the user's library stays
 * recoverable, and an empty session is returned. If it cannot even be set aside,
 * this throws (leaving the file intact) rather than risk a later write overwriting
 * the only copy. A file in a newer format throws {@link NewerFormatError} and is
 * left exactly as it is.
 */
export async function loadSessionFile(
  sessionPath: string,
  options: { requireExisting?: boolean } = {},
): Promise<{ result: SessionLoadResult; session: Session }> {
  let text: string
  try {
    text = await readFile(sessionPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !options.requireExisting) {
      return { result: { status: 'empty' }, session: emptySession() }
    }
    // Unexpected read failure (permissions, I/O): the caller leaves the session
    // unloaded and startup names the file, instead of silently starting empty.
    throw new StoreAccessError(sessionPath, err)
  }
  const found = parseStoreJson(text, FORMAT_VERSIONS.catalog)
  if (found.status === 'newer') throw new NewerFormatError(sessionPath, found.version, FORMAT_VERSIONS.catalog)
  const parsed = found.status === 'read' ? SessionSchema.safeParse(found.value) : null
  if (parsed?.success) {
    return { result: { status: 'loaded', tapeCount: parsed.data.tapes.length }, session: parsed.data }
  }
  if (options.requireExisting) throw new StoreAccessError(sessionPath, new Error('Invalid library catalog'))
  const parseErr = found.status === 'unreadable' ? found.error : parsed?.error
  let quarantinePath: string
  try {
    quarantinePath = await quarantineFile(sessionPath)
  } catch (quarantineErr) {
    const detail = (quarantineErr as Error)?.message ?? String(quarantineErr)
    throw new Error(
      `session file at ${sessionPath} is corrupt and could not be set aside: ${detail}`,
      { cause: parseErr },
    )
  }
  return { result: { status: 'recovered', quarantinePath }, session: emptySession() }
}

/**
 * Load the app's session into the in-memory cache. Idempotent at the app level —
 * called once during startup before any getter/mutator.
 */
export async function loadSession(): Promise<SessionLoadResult> {
  const target = collectionCatalog(getLibraryDir())
  // Only the built-in library is created implicitly. An unavailable chosen drive
  // must not become an empty replacement collection.
  const directory = await stat(getLibraryDir()).catch((cause: unknown) => {
    throw new StoreAccessError(getLibraryDir(), cause)
  })
  if (!directory.isDirectory()) throw new StoreAccessError(getLibraryDir(), new Error('Not a directory'))
  await mkdir(dirname(target), { recursive: true })
  const { result, session } = await loadSessionFile(target)
  bindSession(target, session)
  if (result.status !== 'loaded') {
    lastWritten = null
    await prepareCollection()
  }

  switch (result.status) {
    case 'loaded':
      log.info('session loaded', { tapeCount: result.tapeCount })
      break
    case 'empty':
      log.info('session not found; starting empty')
      break
    case 'recovered':
      log.error('session corrupt; set aside and starting empty', {
        quarantinePath: result.quarantinePath,
      })
      break
  }
  return result
}

/** Bind only after the destination location has durably committed. The caller
 * runs at its library turn and has flushed all previous writes. */
export function bindSession(target: string, session: Session): void {
  cancelScheduledSave()
  catalogPath = target
  cache = session
  lastWritten = encodeCatalog(session)
  rebuildIndexes()
  loaded = true
  saveFailing = false
}

/** Publish catalog.json at `destination` for a library move, at its turn in the
 * save order, saving the cache first so no save lands between the two. */
export function copyCatalogTo(destination: string, signal?: AbortSignal): Promise<{ crossDevice: boolean }> {
  assertLoaded()
  return enqueueCatalogWrite(async () => {
    await writeCatalog(cache)
    copiedForMove = lastWritten
    return linkOrCopyNoOverwrite(catalogPath!, destination, signal)
  })
}

/** A move keeps the same cache at its new location. Changes saved in the old
 * folder after the copy reach the new one with the first save there. */
export function bindMovedSession(libraryDir: string): Promise<boolean> {
  void enqueueCatalogWrite(async () => {
    catalogPath = collectionCatalog(libraryDir)
    lastWritten = copiedForMove
  })
  return persistNow()
}

/** Materialize even an empty collection before it is copied or moved. */
export async function prepareCollection(): Promise<void> {
  assertLoaded()
  await enqueueCatalogWrite(async () => {
    await writeCatalog(cache)
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
  return librarySourceIndex(cache.tapes, exceptId).find(ref)
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

function tapeListKey(tape: Tape): string {
  return tape.archivedAtUtc ? tape.boxId === null ? 'unboxed' : `box:${tape.boxId}` : 'inbox'
}

/** Reindex one list to `requestedIds` first, its other members after by their
 * current order. Ids not in the list are ignored. */
function reorderList(tapes: Tape[], source: string, requestedIds: readonly string[]): Tape[] {
  const members = tapes.filter((tape) => tapeListKey(tape) === source)
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

/** Reorder the list the first submitted tape is in, then await its save. Like
 * any other library edit it applies at once, so a later edit wins over it; a
 * failed save keeps it in the library and is the save owner's to retry and
 * report. Returns the list's rows as they are once saved. */
export async function reorderTapesDurably(orderedIds: readonly string[]): Promise<Tape[]> {
  assertLoaded()
  const submittedIds = [...new Set(orderedIds)]
  const first = submittedIds.map(getTape).find((tape) => tape !== undefined)
  if (!first) return []
  const source = tapeListKey(first)
  cache.tapes = reorderList(cache.tapes, source, submittedIds)
  await persistNow()
  return cache.tapes.filter((tape) => tapeListKey(tape) === source)
}

export type RenameFields = Pick<Tape, 'filename' | 'sidecarFilename' | 'thumbnailFilename' | 'name' | 'renamedAtUtc'>

/** Commit one tape's rename fields to catalog.json before publishing them. This
 * is the transaction boundary for a filesystem rename: new paths must not become
 * authoritative until the durable catalog names them. At its turn in the save
 * order the catalog is written with the fields, which then apply to the row as
 * it is by then; nothing else changes them meanwhile. Returns the current row. */
export async function renameTapeDurably(id: string, fields: RenameFields): Promise<Tape> {
  assertLoaded()
  const renamed = (tapes: Tape[]): Tape[] => tapes.map((tape) => tape.id === id ? { ...tape, ...fields } : tape)
  cancelScheduledSave()
  try {
    await enqueueCatalogWrite(async () => {
      if (!tapePositions.has(id)) throw new Error(`Tape not found during durable rename: ${id}`)
      await writeCatalog({ ...cache, tapes: renamed(cache.tapes) })
      cache.tapes = renamed(cache.tapes)
    })
  } catch (error) {
    // Admission cancelled the ordinary timer; the cache still needs it.
    scheduleSave()
    throw error
  }
  return getTape(id)!
}

export function removeTapes(ids: string[]): void {
  assertLoaded()
  const set = new Set(ids)
  cache.tapes = cache.tapes.filter((i) => !set.has(i.id))
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
    await enqueueCatalogWrite(async () => {
      // Snapshot at execution, not enqueue time: a durable rename ahead of this
      // write may either commit or roll back while this call is waiting its turn.
      // catalog.json is the app's most important durable managed text — the whole
      // tape library structure — so every changed save records through the choke point.
      await writeCatalog(cache)
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

function enqueueCatalogWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = persistChain.then(write)
  persistChain = run.then(() => {}, () => {})
  return run
}
