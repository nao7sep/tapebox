import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { collectionCatalog } from '@main/paths'
import { getLibraryDir } from './config'
import { quarantineFile, writeManagedJsonBytes } from '@main/io/atomic-json'
import { StoreAccessError } from '@main/io/store-access'
import { FORMAT_VERSIONS, NewerFormatError } from '@main/io/format-version'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { portableFilenameIdentity, boxNameIdentity } from '@shared/filename'
import { catalogCodec } from './catalog-codec'
import { TapeSchema, BoxSchema, TRACKED_FILENAME_FIELDS, type Box, type Tape, type Session } from '@shared/domain'

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
const decodedBytes = new WeakMap<Session, Buffer>()
const tapePositions = new Map<string, number>()
const boxPositions = new Map<string, number>()
const filenameOwners = new Map<string, string>()
const boxNameOwners = new Map<string, string>()
/** True from a failed catalog save until the next successful one. */
let saveFailing = false
let saveFailureListener: (() => void) | null = null
/** Only physically outstanding intents are kept. A later admission must not
 * discard an earlier successful save: it is the base if the later save fails.
 * Real organization edits invalidate every intent of that list, including ABA;
 * metadata and other lists remain independent. No history survives settlement. */
const tapeReorderIntents = new Map<string, Set<object>>()
const boxReorderIntents = new Set<object>()

const IN_FLIGHT_STATES: ReadonlySet<Tape['state']> = new Set(['probing', 'ready', 'downloading'])

/**
 * The durable form of a tape. A tape in flight exists only while its job runs; a
 * restart resumes it from the queue, so it is stored as queued, without the
 * attempt's start time. Its probed metadata is kept, as it is real data.
 */
export function durableTape(tape: Tape): Tape {
  if (!IN_FLIGHT_STATES.has(tape.state)) return tape
  return { ...tape, state: 'queued', downloadStartedAtUtc: null }
}

/** Write one worker-encoded durable buffer, reusing its exact bytes for backup. */
async function writeCatalog(session: Session): Promise<void> {
  const encoded = await catalogCodec({ op: 'encode', session })
  if (encoded.kind !== 'encoded') throw new Error(`Catalog encoding failed: ${'detail' in encoded ? encoded.detail : encoded.kind}`)
  const bytes = Buffer.from(encoded.bytes.buffer, encoded.bytes.byteOffset, encoded.bytes.byteLength)
  if (lastWritten?.equals(bytes)) { saveFailing = false; return }
  if (catalogPath === null) throw new Error('Catalog location is not loaded')
  await writeManagedJsonBytes(catalogPath, bytes)
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
  const found = await catalogCodec({ op: 'decode', path: sessionPath })
  if (found.kind === 'error') {
    if (found.code === 'ENOENT' && !options.requireExisting) {
      return { result: { status: 'empty' }, session: emptySession() }
    }
    throw new StoreAccessError(sessionPath, Object.assign(new Error(found.detail), { code: found.code }))
  }
  if (found.kind === 'newer') throw new NewerFormatError(sessionPath, found.version, FORMAT_VERSIONS.catalog)
  if (found.kind === 'decoded') {
    decodedBytes.set(found.session, Buffer.from(found.bytes.buffer, found.bytes.byteOffset, found.bytes.byteLength))
    return { result: { status: 'loaded', tapeCount: found.session.tapes.length }, session: found.session }
  }
  if (options.requireExisting) throw new StoreAccessError(sessionPath, new Error('Invalid library catalog'))
  const parseErr = new Error(found.kind === 'invalid' ? found.detail : 'Unexpected catalog codec response')
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
 * holds the library gate and has flushed all previous writes. */
export function bindSession(target: string, session: Session): void {
  cancelScheduledSave()
  catalogPath = target
  cache = session
  tapeReorderIntents.clear()
  boxReorderIntents.clear()
  lastWritten = decodedBytes.get(session) ?? null
  rebuildIndexes()
  loaded = true
  saveFailing = false
}

/** A move preserves the same cache and durable bytes at its new location. */
export function bindMovedSession(libraryDir: string): void {
  catalogPath = collectionCatalog(libraryDir)
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

export function getTape(id: string): Tape | undefined {
  assertLoaded()
  const index = tapePositions.get(id)
  return index === undefined ? undefined : cache.tapes[index]
}

export function upsertTape(tape: Tape): void {
  assertLoaded()
  tape = admitTape(tape)
  const idx = tapePositions.get(tape.id) ?? -1
  const previous = cache.tapes[idx]
  if (!previous || tapeListKey(previous) !== tapeListKey(tape) || previous.order !== tape.order) {
    if (previous) tapeReorderIntents.delete(tapeListKey(previous))
    tapeReorderIntents.delete(tapeListKey(tape))
  }
  replaceFilenameOwner(previous, tape)
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

/** Persist a submitted source list's order before publishing it. Later authored
 * organization wins over an older candidate; every acknowledgment includes the
 * current source plus its originally owned rows now moved elsewhere. */
export async function reorderTapesDurably(orderedIds: readonly string[]): Promise<Tape[]> {
  assertLoaded()
  // Capture intent before reserving/waiting for the catalog writer. Inferring
  // the source from a surviving id inside the queue could reorder its new list.
  const submittedIds = [...new Set(orderedIds)]
  const byId = new Map(cache.tapes.map((tape) => [tape.id, tape]))
  const first = submittedIds.map((id) => byId.get(id)).find((tape) => tape !== undefined)
  const source = first ? tapeListKey(first) : null
  const originalIds = new Set(cache.tapes.filter((tape) => tapeListKey(tape) === source).map((tape) => tape.id))
  const requestedIds = submittedIds.filter((id) => originalIds.has(id))
  const intent = {}
  if (source !== null) {
    const intents = tapeReorderIntents.get(source) ?? new Set<object>()
    intents.add(intent)
    tapeReorderIntents.set(source, intents)
  }
  cancelScheduledSave()
  try {
    await enqueueCatalogWrite(async () => {
      if (source === null || !tapeReorderIntents.get(source)?.has(intent)) {
        await writeCatalog(cache)
        return
      }
      const namedIds = new Set(requestedIds)
      const sequence = [
        ...requestedIds,
        ...cache.tapes
          .filter((tape) => tapeListKey(tape) === source && !namedIds.has(tape.id))
          .sort((a, b) => a.order - b.order)
          .map((tape) => tape.id),
      ]
      const orderById = new Map(sequence.map((id, order) => [id, order]))
      const candidateTapes = cache.tapes.map((tape) => {
        const order = orderById.get(tape.id)
        return order === undefined || order === tape.order ? tape : { ...tape, order }
      })

      await writeCatalog({ ...cache, tapes: candidateTapes })

      if (tapeReorderIntents.get(source)?.has(intent)) {
        // Apply only order to current rows, preserving newer metadata/downloads.
        cache.tapes = cache.tapes.map((tape) => {
          const order = orderById.get(tape.id)
          return order === undefined || order === tape.order ? tape : { ...tape, order }
        })
      } else {
        // The already-published candidate is obsolete. Organization uses the
        // existing debounced consistency boundary; its current cache is saved
        // by this same serialized owner, never by a second corrective writer.
        scheduleSave()
      }
    })
  } catch (error) {
    // Admission cancelled the ordinary timer. Preserve current metadata and
    // organization through that same owner after a rejected candidate; never
    // retry the rejected order itself.
    scheduleSave()
    throw error
  } finally {
    if (source !== null) {
      const intents = tapeReorderIntents.get(source)
      intents?.delete(intent)
      if (intents?.size === 0) tapeReorderIntents.delete(source)
    }
  }
  return source === null ? [] : cache.tapes.filter((tape) => tapeListKey(tape) === source || originalIds.has(tape.id))
}

/** Commit one tape's rename fields to catalog.json before publishing them to the
 * in-memory session. This is the transaction boundary for a filesystem rename:
 * new paths must not become authoritative until the durable catalog names them.
 * Return the merged current row so callers publish its newer unrelated fields.
 * Ordinary queue/progress updates keep using the debounced upsert above. */
export async function renameTapeDurably(tape: Tape): Promise<Tape> {
  assertLoaded()
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  // Reserve the serialized position immediately. Computing the candidate outside
  // the queued task would let an ordinary persist called while an older write is
  // settling slip in ahead and make candidate paths durable before this transaction.
  let committed = tape
  await enqueueCatalogWrite(async () => {
    const idx = tapePositions.get(tape.id) ?? -1
    if (idx < 0) throw new Error(`Tape not found during durable rename: ${tape.id}`)
    const tapes = [...cache.tapes]
    tapes[idx] = admitTape(applyRenameFields(tapes[idx]!, tape))
    const candidate = { ...cache, tapes }

    await writeCatalog(candidate)

    // The durable rename is now authoritative. Preserve unrelated fields changed
    // by queue/progress work while the write was in flight, and let its already-
    // scheduled ordinary persist serialize the combined current state afterward.
    const currentIdx = tapePositions.get(tape.id) ?? -1
    if (currentIdx >= 0) {
      committed = applyRenameFields(cache.tapes[currentIdx]!, tape)
      replaceFilenameOwner(cache.tapes[currentIdx], committed)
      cache.tapes[currentIdx] = committed
    }
  })
  return committed
}

function applyRenameFields(current: Tape, renamed: Tape): Tape {
  return {
    ...current,
    filename: renamed.filename,
    sidecarFilename: renamed.sidecarFilename,
    thumbnailFilename: renamed.thumbnailFilename,
    name: renamed.name,
    renamedAtUtc: renamed.renamedAtUtc,
  }
}

export function removeTapes(ids: string[]): void {
  assertLoaded()
  const set = new Set(ids)
  for (const tape of cache.tapes) {
    if (set.has(tape.id)) tapeReorderIntents.delete(tapeListKey(tape))
  }
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
  box = BoxSchema.parse(box)
  const name = boxNameIdentity(box.name)
  const owner = boxNameOwners.get(name)
  if (!name || (owner !== undefined && owner !== box.id)) throw new Error('Box names must be non-empty and unique')
  const idx = boxPositions.get(box.id) ?? -1
  if (idx >= 0) boxNameOwners.delete(boxNameIdentity(cache.boxes[idx]!.name))
  boxNameOwners.set(name, box.id)
  if (idx < 0 || cache.boxes[idx]!.order !== box.order) boxReorderIntents.clear()
  if (idx >= 0) cache.boxes[idx] = box
  else {
    boxPositions.set(box.id, cache.boxes.length)
    cache.boxes.push(box)
  }
  scheduleSave()
}

/** Persist the complete box order before publishing it to the cache. */
export async function reorderBoxesDurably(orderedIds: readonly string[]): Promise<Box[]> {
  assertLoaded()
  const submittedIds = [...new Set(orderedIds)]
  const intent = {}
  boxReorderIntents.add(intent)
  cancelScheduledSave()
  try {
    await enqueueCatalogWrite(async () => {
      if (!boxReorderIntents.has(intent)) {
        await writeCatalog(cache)
        return
      }
      const existingIds = new Set(cache.boxes.map((box) => box.id))
      const namedIds = submittedIds.filter((id) => existingIds.has(id))
      const named = new Set(namedIds)
      const sequence = [
        ...namedIds,
        ...cache.boxes
          .filter((box) => !named.has(box.id))
          .sort((a, b) => a.order - b.order)
          .map((box) => box.id),
      ]
      const orderById = new Map(sequence.map((id, order) => [id, order]))
      const candidateBoxes = cache.boxes.map((box) => {
        const order = orderById.get(box.id)
        return order === undefined || order === box.order ? box : { ...box, order }
      })

      await writeCatalog({ ...cache, boxes: candidateBoxes })
      if (boxReorderIntents.has(intent)) {
        cache.boxes = cache.boxes.map((box) => {
          const order = orderById.get(box.id)
          return order === undefined || order === box.order ? box : { ...box, order }
        })
      } else scheduleSave()
    })
  } catch (error) {
    scheduleSave()
    throw error
  } finally {
    boxReorderIntents.delete(intent)
  }
  return cache.boxes
}

export function removeBox(id: string): void {
  assertLoaded()
  if (cache.tapes.some((tape) => tape.boxId === id)) throw new Error(`Box is still referenced: ${id}`)
  if (boxPositions.has(id)) {
    boxReorderIntents.clear()
    tapeReorderIntents.delete(`box:${id}`)
  }
  cache.boxes = cache.boxes.filter((g) => g.id !== id)
  rebuildIndexes()
  scheduleSave()
}

/** Indexes are derived from the authoritative arrays, never a second catalog. */
function rebuildIndexes(): void {
  tapePositions.clear()
  boxPositions.clear()
  filenameOwners.clear()
  boxNameOwners.clear()
  cache.tapes.forEach((tape, index) => {
    tapePositions.set(tape.id, index)
    replaceFilenameOwner(undefined, tape)
  })
  cache.boxes.forEach((box, index) => {
    boxPositions.set(box.id, index)
    boxNameOwners.set(boxNameIdentity(box.name), box.id)
  })
}

function admitTape(value: Tape): Tape {
  const tape = TapeSchema.parse(value)
  if (tape.boxId !== null && !boxPositions.has(tape.boxId)) throw new Error(`Unknown box: ${tape.boxId}`)
  const own = new Set<string>()
  for (const field of TRACKED_FILENAME_FIELDS) {
    const filename = tape[field]
    if (filename === null) continue
    const identity = portableFilenameIdentity(filename)
    const owner = filenameOwners.get(identity)
    if (own.has(identity) || (owner !== undefined && owner !== tape.id)) throw new Error(`Tracked filename is already in use: ${filename}`)
    own.add(identity)
  }
  return tape
}

function replaceFilenameOwner(previous: Tape | undefined, next: Tape): void {
  if (previous) for (const field of TRACKED_FILENAME_FIELDS) {
    const filename = previous[field]
    if (filename !== null) filenameOwners.delete(portableFilenameIdentity(filename))
  }
  for (const field of TRACKED_FILENAME_FIELDS) {
    const filename = next[field]
    if (filename !== null) filenameOwners.set(portableFilenameIdentity(filename), next.id)
  }
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

function enqueueCatalogWrite(write: () => Promise<void>): Promise<void> {
  const run = persistChain.then(write)
  persistChain = run.catch(() => {})
  return run
}
