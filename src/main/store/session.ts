import { readFile, rename } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { paths } from '@main/paths'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { utcTimestampForFilename } from '@shared/utc'
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
 * timestamped `catalog.corrupt-*.json` sibling so the user's library stays
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
    const quarantinePath = join(
      dirname(sessionPath),
      `catalog.corrupt-${utcTimestampForFilename()}.json`,
    )
    try {
      await rename(sessionPath, quarantinePath)
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

export function removeBox(id: string): void {
  assertLoaded()
  cache.boxes = cache.boxes.filter((g) => g.id !== id)
  scheduleSave()
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void persistNow() }, SAVE_DEBOUNCE_MS)
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
    await writeJsonAtomic(paths.catalog, cache, SessionSchema)
  } catch (err) {
    log.error('session persist failed', { error: describeError(err) })
    throw err
  }
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
    const tmp = `${paths.catalog}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, paths.catalog)
  } catch (err) {
    log.error('session sync persist failed', { error: describeError(err) })
  }
}
