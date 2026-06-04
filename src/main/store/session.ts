import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { SessionSchema, type Box, type Tape, type Session } from '@shared/domain'

/**
 * In-memory session cache, debounced atomic persistence to session.json.
 * Single instance per main process. Live progress fields are NOT persisted —
 * they're rebuilt by the queue at runtime.
 */

const SAVE_DEBOUNCE_MS = 500

let cache: Session = { tapes: [], boxes: [] }
let saveTimer: NodeJS.Timeout | null = null
let loaded = false

export async function loadSession(): Promise<void> {
  const found = await readJsonOptional(paths.session, SessionSchema)
  if (found) {
    cache = found
    log.info('session loaded', { tapeCount: cache.tapes.length })
  } else {
    log.info('session not found; starting empty')
  }
  loaded = true
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
 */
export async function persistNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    await writeJsonAtomic(paths.session, cache, SessionSchema)
  } catch (err) {
    log.error('session persist failed', { error: String(err) })
    throw err
  }
}
