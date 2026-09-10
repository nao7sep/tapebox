import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { LayoutSchema, defaultLayout, type Layout } from '@shared/layout'

/**
 * In-memory view-state cache + debounced atomic persistence to layout.json.
 * Self-healing on load (a missing or invalid file falls back to defaults)
 * because it holds no data worth protecting — the opposite policy from the
 * session store. Writes are debounced so rapid updates collapse into one write.
 */

const SAVE_DEBOUNCE_MS = 500

let cache: Layout = { ...defaultLayout }
let saveTimer: NodeJS.Timeout | null = null
let writeQueue: Promise<void> = Promise.resolve()

export async function loadLayout(): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(paths.layout, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('layout unreadable; using defaults', { error: describeError(err) })
    }
    cache = { ...defaultLayout }
    return
  }
  const parsed = LayoutSchema.safeParse(raw)
  if (parsed.success) {
    cache = parsed.data
  } else {
    log.warn('layout invalid; using defaults', { error: describeError(parsed.error) })
    cache = { ...defaultLayout }
  }
}

export function getLayout(): Layout {
  return cache
}

export function updateLayout(patch: Partial<Layout>): Layout {
  cache = LayoutSchema.parse({ ...cache, ...patch })
  scheduleSave()
  return cache
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void persistNow() }, SAVE_DEBOUNCE_MS)
}

/** Flush pending writes. Called on app quit; also safe to call any time. */
export async function persistNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const write = writeQueue.then(async () => {
    // Snapshot inside the serialized turn so a newer cache always wins after an
    // older in-flight write. Overlapping renderer updates must not race.
    const snapshot = structuredClone(cache)
    // layout.json is durable managed text: every save records through the shared
    // choke point, whose per-path content dedup absorbs unchanged state.
    await writeManagedJson(paths.layout, snapshot, LayoutSchema)
  })
  writeQueue = write.catch(() => {})
  try { await write } catch (err) {
    log.error('layout persist failed', { error: describeError(err) })
  }
}
