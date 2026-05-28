import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { SessionSchema, type Item, type Session } from '@shared/domain'

/**
 * In-memory session cache, debounced atomic persistence to session.json.
 * Single instance per main process. Live progress fields are NOT persisted —
 * they're rebuilt by the queue at runtime.
 */

const SAVE_DEBOUNCE_MS = 500

let cache: Session = { schemaVersion: 1, items: [] }
let saveTimer: NodeJS.Timeout | null = null
let loaded = false

export async function loadSession(): Promise<void> {
  const found = await readJsonOptional(paths.session, SessionSchema)
  if (found) {
    cache = found
    log.info('session loaded', { itemCount: cache.items.length })
  } else {
    log.info('session not found; starting empty')
  }
  loaded = true
}

function assertLoaded(): void {
  if (!loaded) throw new Error('session.ts: loadSession() must be awaited first')
}

export function getItems(): Item[] {
  assertLoaded()
  return cache.items
}

export function getItem(id: string): Item | undefined {
  assertLoaded()
  return cache.items.find((i) => i.id === id)
}

export function upsertItem(item: Item): void {
  assertLoaded()
  const idx = cache.items.findIndex((i) => i.id === item.id)
  if (idx >= 0) cache.items[idx] = item
  else cache.items.push(item)
  scheduleSave()
}

export function removeItems(ids: string[]): void {
  assertLoaded()
  const set = new Set(ids)
  cache.items = cache.items.filter((i) => !set.has(i.id))
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
