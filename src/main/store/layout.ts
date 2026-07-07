import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { LayoutSchema, defaultLayout, type Layout } from '@shared/layout'

/**
 * In-memory layout cache + debounced atomic persistence to layout.json.
 *
 * Window geometry the user drags. Self-healing on load (a missing or invalid
 * file falls back to defaults) because it holds no data worth protecting — the
 * opposite policy from the session store. Writes are debounced so a drag that
 * fires dozens of updates collapses to one disk write on release.
 */

const SAVE_DEBOUNCE_MS = 500

let cache: Layout = { ...defaultLayout }
let saveTimer: NodeJS.Timeout | null = null

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
  try {
    // layout.json is durable managed TEXT: it records on every save through the
    // choke point. Window geometry churns, but the store's per-path content dedup
    // absorbs that — an unchanged geometry save writes no row (data-backup
    // conventions: managed text is recorded; there is no "exclude volatile" rule).
    await writeManagedJson(paths.layout, cache, LayoutSchema)
  } catch (err) {
    log.error('layout persist failed', { error: describeError(err) })
  }
}
