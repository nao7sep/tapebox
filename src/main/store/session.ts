import { readFile } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { nanoid } from 'nanoid'
import { paths } from '@main/paths'
import { quarantineFile, writeManagedJson } from '@main/io/atomic-json'
import { recordBeforeExit } from '@main/store/backupStore'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { SessionSchema, type Box, type Tape, type Session } from '@shared/domain'

/**
 * In-memory session cache, debounced atomic persistence to catalog.json.
 * Single instance per main process. Live progress fields are NOT persisted —
 * they're rebuilt by the queue at runtime.
 */

const SAVE_DEBOUNCE_MS = 500

let cache: Session = emptySession()
let saveTimer: NodeJS.Timeout | null = null
let loaded = false
let persistChain: Promise<void> = Promise.resolve()

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
 * the only copy.
 */
export async function loadSessionFile(
  sessionPath: string,
): Promise<{ result: SessionLoadResult; session: Session }> {
  let text: string
  try {
    text = await readFile(sessionPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { result: { status: 'empty' }, session: emptySession() }
    }
    // Unexpected read failure (permissions, I/O): propagate so the caller leaves
    // the session unloaded and aborts, instead of silently starting empty.
    throw err
  }

  try {
    const session = SessionSchema.parse(JSON.parse(text))
    return { result: { status: 'loaded', tapeCount: session.tapes.length }, session }
  } catch (parseErr) {
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
}

/**
 * Load the app's session into the in-memory cache. Idempotent at the app level —
 * called once during startup before any getter/mutator.
 */
export async function loadSession(): Promise<SessionLoadResult> {
  const { result, session } = await loadSessionFile(paths.catalog)
  cache = session
  loaded = true
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

function assertLoaded(): void {
  if (!loaded) throw new Error('session.ts: loadSession() must be awaited first')
}

export function getTapes(): Tape[] {
  assertLoaded()
  return cache.tapes
}

export function getTape(id: string): Tape | undefined {
  assertLoaded()
  return cache.tapes.find((i) => i.id === id)
}

export function upsertTape(tape: Tape): void {
  assertLoaded()
  const idx = cache.tapes.findIndex((i) => i.id === tape.id)
  if (idx >= 0) cache.tapes[idx] = tape
  else cache.tapes.push(tape)
  scheduleSave()
}

/** Persist one list's complete tape order before publishing it to the cache. */
export async function reorderTapesDurably(orderedIds: readonly string[]): Promise<Tape[]> {
  assertLoaded()
  cancelScheduledSave()
  let committed: Tape[] = []
  await enqueueCatalogWrite(async () => {
    const byId = new Map(cache.tapes.map((tape) => [tape.id, tape]))
    const seen = new Set<string>()
    const named = orderedIds
      .filter((id) => !seen.has(id) && seen.add(id))
      .map((id) => byId.get(id))
      .filter((tape): tape is Tape => !!tape)
    if (named.length === 0) {
      await writeManagedJson(
        paths.catalog,
        { tapes: [...cache.tapes], boxes: [...cache.boxes] },
        SessionSchema,
      )
      return
    }

    const listKey = (tape: Tape) =>
      tape.archivedAtUtc ? `box:${tape.boxId ?? 'unboxed'}` : 'inbox'
    const key = listKey(named[0]!)
    const namedInList = named.filter((tape) => listKey(tape) === key)
    const namedIds = new Set(namedInList.map((tape) => tape.id))
    const sequence = [
      ...namedInList.map((tape) => tape.id),
      ...cache.tapes
        .filter((tape) => listKey(tape) === key && !namedIds.has(tape.id))
        .sort((a, b) => a.order - b.order)
        .map((tape) => tape.id),
    ]
    const orderById = new Map(sequence.map((id, order) => [id, order]))
    const candidateTapes = cache.tapes.map((tape) => {
      const order = orderById.get(tape.id)
      return order === undefined || order === tape.order ? tape : { ...tape, order }
    })
    const changedIds = new Set(
      candidateTapes
        .filter((tape, index) => tape !== cache.tapes[index])
        .map((tape) => tape.id),
    )

    await writeManagedJson(paths.catalog, { ...cache, tapes: candidateTapes }, SessionSchema)

    // Preserve unrelated fields changed while the durable write was in flight.
    cache.tapes = cache.tapes.map((tape) => {
      const order = orderById.get(tape.id)
      return order === undefined || order === tape.order ? tape : { ...tape, order }
    })
    committed = cache.tapes.filter((tape) => changedIds.has(tape.id))
  })
  return committed
}

/** Commit one tape's rename fields to catalog.json before publishing them to the
 * in-memory session. This is the transaction boundary for a filesystem rename:
 * new paths must not become authoritative until the durable catalog names them.
 * Ordinary queue/progress updates keep using the debounced upsert above. */
export async function renameTapeDurably(tape: Tape): Promise<void> {
  assertLoaded()
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  // Reserve the serialized position immediately. Computing the candidate outside
  // the queued task would let an ordinary persist called while an older write is
  // settling slip in ahead and make candidate paths durable before this transaction.
  await enqueueCatalogWrite(async () => {
    const idx = cache.tapes.findIndex((item) => item.id === tape.id)
    if (idx < 0) throw new Error(`Tape not found during durable rename: ${tape.id}`)
    const tapes = [...cache.tapes]
    tapes[idx] = applyRenameFields(tapes[idx]!, tape)
    const candidate = { ...cache, tapes }

    await writeManagedJson(paths.catalog, candidate, SessionSchema)

    // The durable rename is now authoritative. Preserve unrelated fields changed
    // by queue/progress work while the write was in flight, and let its already-
    // scheduled ordinary persist serialize the combined current state afterward.
    const currentIdx = cache.tapes.findIndex((item) => item.id === tape.id)
    if (currentIdx >= 0) {
      cache.tapes[currentIdx] = applyRenameFields(cache.tapes[currentIdx]!, tape)
    }
  })
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
  cache.tapes = cache.tapes.filter((i) => !set.has(i.id))
  scheduleSave()
}

export function getBoxes(): Box[] {
  assertLoaded()
  return cache.boxes
}

export function upsertBox(box: Box): void {
  assertLoaded()
  const idx = cache.boxes.findIndex((g) => g.id === box.id)
  if (idx >= 0) cache.boxes[idx] = box
  else cache.boxes.push(box)
  scheduleSave()
}

/** Persist the complete box order before publishing it to the cache. */
export async function reorderBoxesDurably(orderedIds: readonly string[]): Promise<Box[]> {
  assertLoaded()
  cancelScheduledSave()
  let committed: Box[] = []
  await enqueueCatalogWrite(async () => {
    const byId = new Map(cache.boxes.map((box) => [box.id, box]))
    const seen = new Set<string>()
    const namedIds = orderedIds.filter((id) => byId.has(id) && !seen.has(id) && seen.add(id))
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
    const changedIds = new Set(
      candidateBoxes
        .filter((box, index) => box !== cache.boxes[index])
        .map((box) => box.id),
    )

    await writeManagedJson(paths.catalog, { ...cache, boxes: candidateBoxes }, SessionSchema)
    cache.boxes = cache.boxes.map((box) => {
      const order = orderById.get(box.id)
      return order === undefined || order === box.order ? box : { ...box, order }
    })
    committed = cache.boxes.filter((box) => changedIds.has(box.id))
  })
  return committed
}

export function removeBox(id: string): void {
  assertLoaded()
  cache.boxes = cache.boxes.filter((g) => g.id !== id)
  scheduleSave()
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void persistNow() }, SAVE_DEBOUNCE_MS)
}

function cancelScheduledSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

/**
 * Flush pending writes. Called on app quit; also safe to call any time.
 * No-op until a session has actually been loaded, so a startup that aborts before
 * load (e.g. an unreadable or un-quarantinable file) can never overwrite the
 * on-disk file with the empty default.
 */
export async function persistNow(): Promise<void> {
  if (!loaded) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    await enqueueCatalogWrite(async () => {
      // Snapshot at execution, not enqueue time: a durable rename ahead of this
      // write may either commit or roll back while this call is waiting its turn.
      const snapshot = { tapes: [...cache.tapes], boxes: [...cache.boxes] }
      // catalog.json is the app's most important durable managed text — the whole
      // tape library structure — so it records on every save through the choke point.
      await writeManagedJson(paths.catalog, snapshot, SessionSchema)
    })
  } catch (err) {
    log.error('session persist failed', { error: describeError(err) })
    throw err
  }
}

function enqueueCatalogWrite(write: () => Promise<void>): Promise<void> {
  const run = persistChain.then(write)
  persistChain = run.catch(() => {})
  return run
}

/**
 * Synchronous best-effort flush for terminal paths (uncaughtException, process
 * 'exit') where the async persistNow cannot run. Only writes when a save is
 * actually pending, so a clean shutdown that already flushed is a no-op.
 */
export function persistNowSync(): void {
  if (!loaded || !saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    const text = JSON.stringify(SessionSchema.parse(cache), null, 2) + '\n'
    const bytes = Buffer.from(text, 'utf8')
    const stem = paths.catalog.slice(0, -extname(paths.catalog).length)
    const tmp = `${stem}-${nanoid(10)}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, paths.catalog)
    // This is a managed-text save on a terminal path (uncaughtException / process
    // 'exit'), where the async writeManagedJson choke point cannot run — so it
    // records here directly, STRICTLY AFTER the sync rename lands, reusing the
    // in-hand bytes. This terminal-only path makes its bounded SQLite attempt now;
    // there is no event-loop turn left for the ordinary queue.
    recordBeforeExit(paths.catalog, bytes)
  } catch (err) {
    log.error('session sync persist failed', { error: describeError(err) })
  }
}
